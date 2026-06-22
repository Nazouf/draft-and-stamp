/* =====================================================================
   APP — state, utilities, auth, Supabase, pipeline, events, init
   ===================================================================== */
/* =====================================================================
   AUTH — Supabase authentication + run/feedback persistence
   ===================================================================== */
let sbClient = null;
let currentUser = null;
let isAdmin = false;
let appInitialized = false; // true once initApp() finishes (hides loading flash)
let unrestrictedMode = true;
let currentRunId = null;
let authMode = "signin"; // "signin" | "signup"
let authView = "choice"; // "choice" | "form" | "forgot"
let authLoading = false;
let authError = null;
let authSuccess = null;
let pendingPasswordRecovery = false;

async function fetchIsAdmin(user){
  if (!user || !sbClient) return false;
  try {
    const { data } = await sbClient.from("profiles").select("is_admin").eq("id", user.id).single();
    return data?.is_admin === true;
  } catch(e){ return false; }
}

async function initApp(){
  let cfg = {};
  try { cfg = await fetch("/api/config").then(r => r.json()); } catch(e){ /* offline / no server */ }
  unrestrictedMode = cfg.unrestrictedMode !== false;

  if (cfg.supabaseUrl && cfg.supabaseAnonKey){
    sbClient = supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    const { data: { session } } = await sbClient.auth.getSession();
    currentUser = session?.user || null;
    isAdmin = await fetchIsAdmin(currentUser);
    sbClient.auth.onAuthStateChange(async (event, session) => {
      if (event === "PASSWORD_RECOVERY") {
        currentUser = session?.user || null;
        pendingPasswordRecovery = true;
        authLoading = false;
        renderAll();
        return;
      }
      currentUser = session?.user || null;
      authLoading = false;
      isAdmin = await fetchIsAdmin(currentUser);
      renderAll();
    });
  }
  appInitialized = true;
  const shareMatch = window.location.pathname.match(/^\/share\/([0-9a-f-]{36})$/i);
  if (shareMatch) {
    await loadSharedRun(shareMatch[1]);
  } else {
    renderAll();
  }
}

// Refreshes whichever auth surface is currently visible (inline screen or modal).
function refreshAuth(){
  if (document.getElementById("auth-overlay").style.display !== "none") renderAuthModal();
  renderAll();
}

function openLogin(){
  authMode = "signin"; authView = "choice"; authError = null; authSuccess = null; authLoading = false;
  document.getElementById("auth-overlay").style.display = "flex";
  renderAuthModal();
}
function closeLogin(){
  document.getElementById("auth-overlay").style.display = "none";
}

function authMsg(err){
  // Supabase returns "{}" when email enumeration protection hides the real error.
  // We also guard against undefined/object messages just in case.
  const msg = err && typeof err.message === "string" ? err.message.trim() : "";
  if (!msg || msg === "{}" || msg === "[]") return "Check your email and password and try again.";
  return msg;
}

async function signInWithEmail(){
  if (!sbClient || authLoading) return;
  const emailEl = document.getElementById("auth-email");
  const passEl  = document.getElementById("auth-password");
  if (!emailEl || !passEl) return;
  const email    = emailEl.value.trim();
  const password = passEl.value;
  if (!email || !password){ authError = "Enter your email and password."; refreshAuth(); return; }
  authLoading = true; authError = null; refreshAuth();
  const { error } = await sbClient.auth.signInWithPassword({ email, password });
  authLoading = false;
  if (error){ authError = authMsg(error); refreshAuth(); }
  // Success: onAuthStateChange fires, sets currentUser, calls renderAll()
}

async function signUpWithEmail(){
  if (!sbClient || authLoading) return;
  const emailEl = document.getElementById("auth-email");
  const passEl  = document.getElementById("auth-password");
  if (!emailEl || !passEl) return;
  const email    = emailEl.value.trim();
  const password = passEl.value;
  if (!email || !password){ authError = "Enter your email and password."; refreshAuth(); return; }
  if (password.length < 6){ authError = "Password must be at least 6 characters."; refreshAuth(); return; }
  authLoading = true; authError = null; refreshAuth();
  const { error } = await sbClient.auth.signUp({ email, password });
  authLoading = false;
  if (error){ authError = authMsg(error); refreshAuth(); }
  else { authSuccess = "Check your email to confirm your account, then sign in."; authMode = "signin"; refreshAuth(); }
}

async function signOut(){
  if (!sbClient) return;
  await sbClient.auth.signOut();
}

async function forgotPasswordWithEmail(){
  if (!sbClient || authLoading) return;
  const emailEl = document.getElementById("auth-email");
  if (!emailEl) return;
  const email = emailEl.value.trim();
  if (!email){ authError = "Enter your email address."; refreshAuth(); return; }
  authLoading = true; authError = null; refreshAuth();
  const { error } = await sbClient.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
  authLoading = false;
  if (error){ authError = authMsg(error); } else { authSuccess = "Check your email for a reset link."; }
  refreshAuth();
}

async function updatePassword(){
  if (!sbClient || authLoading) return;
  const field = document.getElementById("recovery-password");
  if (!field) return;
  const password = field.value;
  if (password.length < 6){ authError = "Password must be at least 6 characters."; renderAll(); return; }
  authLoading = true; authError = null; renderAll();
  const { error } = await sbClient.auth.updateUser({ password });
  authLoading = false;
  if (error){ authError = authMsg(error); renderAll(); return; }
  pendingPasswordRecovery = false;
  authSuccess = "Password updated!";
  renderAll();
  setTimeout(() => { authSuccess = null; renderAll(); }, 2500);
}

async function saveRun(){
  if (!sbClient || !state.finalResult) return null;
  const c = state.classification;
  try{
    if (currentRunId){
      await sbClient.from("runs").update({ generated_prompts: state.finalResult.prompts }).eq("id", currentRunId);
      return currentRunId;
    }
    const { data, error } = await sbClient.from("runs").insert({
      user_id: currentUser?.id || null,
      request: state.originalRequest,
      destination: state.destination,
      category: c?.primary_category || null,
      complexity: c?.complexity || null,
      stakes: c?.stakes || null,
      output_format: c?.output_format || null,
      mode: state.mode,
      qa_pairs: state.qaHistory,
      generated_prompts: state.finalResult.prompts
    }).select("id").single();
    if (error){ console.error("saveRun:", error.message); return null; }
    return data?.id || null;
  } catch(e){ console.error("saveRun:", e); return null; }
}

async function saveFeedbackToDb(fields){
  if (!sbClient || !currentRunId || !currentUser) return;
  try {
    const row = Object.assign({ run_id: currentRunId, user_id: currentUser.id }, fields);
    await sbClient.from("feedback").upsert(row, { onConflict: "run_id,user_id" });
  } catch(e){ console.error("saveFeedback:", e); }
}

/* =====================================================================
   SESSION STATE (mirrors interview_sessions)
   ===================================================================== */
function freshState(){
  return {
    screen:"start",
    originalRequest:"",
    destination:"claude",
    mode:"interview",
    classification:null,
    requiredTopics:[],
    considerationsDone:false,
    qaHistory:[],
    currentQuestion:null,
    multiSelections:[],
    customAnswerMode:false,
    freeTextDraft:"",
    stagePlan:null,
    finalResult:null,
    usageEvents:[],
    promptRating:null,
    resultsRating:null,
    feedbackComment:"",
    feedbackSent:false,
    error:null,
    startError:null,
    gateReason:null,
    sessionCost:null,
    decisionsOpen:false,
    ledgerOpen:false,
    topicsOpen:false,
    updateAvailable:false,
    _stampTimer:null,
    _typeInterval:null,
    showSkipReason:false
  };
}
let state = freshState();

// Dark mode — persisted in localStorage, applied immediately to avoid flash
let darkMode = localStorage.getItem("darkMode") === "true";
if (darkMode) document.body.classList.add("dark");

// Review-answers screen state
let reviewEditIndex = null;
let reviewEditValue = "";

// History screen state — outside freshState() so startOver() doesn't clear it
let sharedRun = null; // populated when visiting /share/:id

let historyRuns = [];
let historyPage = 0;
let historyTotal = 0;
let historyLoading = false;
let historyExpanded = new Set();
let historySearch = "";
let historySearchTimer = null;

let generateElapsed = 0;
let generateTimerInterval = null;

let funnelSessionId = null;

// History: soft-hide runs client-side (localStorage) without deleting from DB
let hiddenRunIds = new Set(JSON.parse(localStorage.getItem("hiddenRuns") || "[]"));

function hideRun(id) {
  hiddenRunIds.add(id);
  localStorage.setItem("hiddenRuns", JSON.stringify([...hiddenRunIds]));
  historyRuns = historyRuns.filter(r => !hiddenRunIds.has(r.id));
  historyTotal = Math.max(0, historyTotal - 1);
  renderAll();
}

// Typewriter state — tracked outside freshState() so copy buttons can check it
let typewriterDone = true;

function completeTypewriter() {
  if (typewriterDone) return;
  clearInterval(state._typeInterval);
  typewriterDone = true;
  const prompts = (state.finalResult && state.finalResult.prompts) || [];
  prompts.forEach((p, i) => {
    const el = document.getElementById("prompt-text-" + i);
    if (el) el.textContent = p.content;
  });
  document.querySelectorAll(".prompt-copy-btn[data-action='copy-prompt']").forEach(btn => { btn.disabled = false; btn.style.opacity = ""; });
}

// Undo last interview answer — pop most recent QA item and restore the question
function backQuestion() {
  if (!state.qaHistory.length) return;
  const last = state.qaHistory.pop();
  if (last.covers_topic_id) {
    const t = state.requiredTopics.find(rt => rt.id === last.covers_topic_id);
    if (t) t.covered = false;
  }
  state.currentQuestion = last._question || { id: last.id, text: last.text, input_type: last.input_type || "free_text", options: null };
  state.multiSelections = [];
  state.customAnswerMode = false;
  state.freeTextDraft = (last.answer && !last.answer.startsWith("(skipped")) ? last.answer : "";
  state.screen = "interview";
  renderAll();
}
function fireFunnelEvent(event, extra){
  if (!funnelSessionId || !sbClient) return;
  (async () => {
    try{
      const session = await sbClient.auth.getSession();
      const token = session?.data?.session?.access_token;
      fetch("/api/funnel", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? {"Authorization":"Bearer "+token} : {}) },
        body: JSON.stringify({ session_id: funnelSessionId, event, ...extra })
      }).catch(() => {});
    } catch(e){}
  })();
}

function logUsage(step, model, usage){
  state.usageEvents.push({step, model, input_tokens:usage.input_tokens||0, output_tokens:usage.output_tokens||0});
}

/* =====================================================================
   API — calls this app's own server, which holds the real key. The
   browser never sees it and never talks to Google directly.
   ===================================================================== */
async function callGemini(systemPrompt, userMessage, responseSchema, maxOutputTokens, enableThinking, model, _retry){
  if (_retry === undefined) _retry = 0;
  const genConfig = {
    responseMimeType: "application/json",
    responseSchema: responseSchema,
    maxOutputTokens: maxOutputTokens || 1000
  };
  if (enableThinking === false){
    genConfig.thinkingConfig = { thinkingBudget: 0 };
  }
  const headers = { "Content-Type":"application/json" };
  if (sbClient){
    const { data: { session } } = await sbClient.auth.getSession();
    if (session?.access_token) headers["Authorization"] = "Bearer " + session.access_token;
  }
  // Shorter timeout for quick steps; longer for generate which can legitimately take 60-90s
  const timeoutMs = (maxOutputTokens || 1000) > 2000 ? 90000 : 25000;
  const controller = new AbortController();
  const timeoutId = setTimeout(function(){ controller.abort(); }, timeoutMs);
  let response;
  try {
    response = await fetch("/api/gemini", {
      method:"POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: model || STRONG_MODEL,
        systemInstruction: { parts:[{ text: systemPrompt }] },
        contents: [{ parts:[{ text: userMessage }] }],
        generationConfig: genConfig
      })
    });
  } catch(e) {
    clearTimeout(timeoutId);
    if (e.name === "AbortError") throw new Error("timeout_failure");
    throw new Error("network_failure");
  }
  clearTimeout(timeoutId);
  const data = await response.json();
  if (!response.ok || data.error){
    const errMsg = (data.error && data.error.message) || ("Request failed (" + response.status + ")");
    // Auto-retry up to 2x for capacity/overload errors before surfacing to the user
    const isCapacity = response.status === 503 ||
      errMsg.includes("high demand") || errMsg.includes("overloaded") || errMsg.includes("temporarily unavailable");
    if (isCapacity && _retry < 2){
      await new Promise(function(r){ setTimeout(r, 2000 * (_retry + 1)); });
      return callGemini(systemPrompt, userMessage, responseSchema, maxOutputTokens, enableThinking, model, _retry + 1);
    }
    throw new Error(errMsg);
  }
  const candidate = (data.candidates || [])[0];
  const text = candidate && candidate.content && candidate.content.parts
    ? candidate.content.parts.map(p => p.text || "").join("")
    : "";
  if (candidate && candidate.finishReason === "MAX_TOKENS"){
    throw new Error("The response ran out of room (hit the token limit) before finishing — try again.");
  }
  const usageMeta = data.usageMetadata || {};
  const usage = {
    input_tokens: usageMeta.promptTokenCount || 0,
    output_tokens: (usageMeta.candidatesTokenCount || 0) + (usageMeta.thoughtsTokenCount || 0)
  };
  return { text, usage };
}

// Gemini's responseSchema enforcement guarantees valid, fence-free JSON, so
// this no longer needs to hunt for braces or strip markdown fences — it's a
// direct parse, with a clear error only for the genuinely unexpected case.
function parseJSON(text){
  try{
    return JSON.parse(text);
  } catch(e){
    throw new Error("Got back something that wasn't valid JSON. Try again.");
  }
}

/* =====================================================================
   RESPONSE SCHEMAS (Gemini responseSchema — shape is now enforced by the
   API itself, not just requested in the prompt text)
   ===================================================================== */


/* =====================================================================
   PROMPT BUILDERS
   ===================================================================== */
function maxQuestions(){
  const c = state.classification;
  // High safety ceiling — the model's own "complete" signal is the real stopper.
  // Critical questions (foundational/identifying) must not be cut short by an
  // arbitrary number; enrichment questions taper off as the model chooses.
  const base = (c && c.complexity === "big") ? 20 : 12;
  const pendingRequired = state.requiredTopics.filter(t => !t.dismissed && !t.covered).length;
  return Math.max(base, state.qaHistory.length + pendingRequired);
}
function buildClassifyMsg(){
  return 'Destination: ' + state.destination + '\nUser request: "' + state.originalRequest + '"';
}
function buildConsiderationsMsg(){
  const c = state.classification;
  return [
    'Original request: "' + state.originalRequest + '"',
    "Destination: " + state.destination,
    "Category: " + c.primary_category + (c.secondary_category ? (" (secondary: " + c.secondary_category + ")") : ""),
    "Complexity: " + c.complexity,
    "Stakes tier: " + c.stakes
  ].join("\n");
}
function buildSelectQuestionMsg(forceTopic){
  const c = state.classification;
  const cats = [c.primary_category, c.secondary_category].filter(Boolean);
  let seeds = [];
  cats.forEach(cat => { seeds = seeds.concat(TOPIC_SEEDS[cat] || []); });
  const pendingRequired = state.requiredTopics.filter(t => !t.dismissed && !t.covered);
  const lines = [
    'Original request: "' + state.originalRequest + '"',
    "Destination: " + state.destination,
    "Primary category: " + c.primary_category + (c.secondary_category ? (" (secondary: " + c.secondary_category + ")") : ""),
    "Complexity: " + c.complexity,
    "Stakes: " + c.stakes,
    "Questions asked so far this session: " + state.qaHistory.length,
    ...(function(){
      const n = state.qaHistory.length;
      const isBig = c.complexity === "big";
      const enrichmentStart = isBig ? 5 : 4;
      const hardCap = isBig ? 12 : 9;
      if (n >= hardCap) return ["BUDGET WARNING: " + n + " questions asked. Hard ceiling reached. You MUST set action to \"complete\" unless a CRITICAL question is genuinely still unanswered and its absence would produce placeholder output. If no critical gaps remain: stop now."];
      if (n >= enrichmentStart) return ["Note: " + n + " questions asked. If all critical questions are resolved, enrichment cap applies — max 1 more enrichment question for small tasks, 2 for big. If critical questions are still unanswered (e.g. sender's name, real achievements, certifications), continue asking them — critical questions are never capped by count."];
      return [];
    })(),
    ...(c.contradictions && c.contradictions.length ? ["", "Contradictions detected in original request (resolve early):", JSON.stringify(c.contradictions)] : []),
    "",
    "Topics that are often worth probing for this category (inspiration only, not a checklist):",
    JSON.stringify(seeds),
    "",
    "Required topics not yet covered (JSON) — see required_topics_hard_rule:",
    JSON.stringify(pendingRequired.map(t => ({id:t.id, label:t.label, reason:t.reason}))),
    "",
    "Already answered this session (JSON):",
    JSON.stringify(state.qaHistory.map(q => ({question_id:q.id, text:q.text, answer:q.answer})))
  ];
  if (forceTopic){
    lines.push("");
    lines.push("OVERRIDE FOR THIS TURN ONLY: a previous turn failed to honor the hard rule. " +
      "You must write a question covering exactly this required topic now — do not ask about " +
      "anything else, and do not set action to complete: " + JSON.stringify(forceTopic));
  }
  return lines.join("\n");
}
function buildStagePlannerMsg(){
  const c = state.classification;
  const hint = STAGE_HINTS[c.primary_category] || "No specific guidance for this category — decide from general best practice.";
  return [
    "Category: " + c.primary_category,
    "Output format requested: " + (c.output_format || "auto"),
    "Original request: \"" + state.originalRequest + "\"",
    "Informal guidance on how this category often stages (inspiration only):",
    hint,
    "",
    "Interview answers (JSON):",
    JSON.stringify(state.qaHistory.map(q => ({question_id:q.id, text:q.text, answer:q.answer})))
  ].join("\n");
}
function buildGenerateMsg(){
  const c = state.classification;
  const lines = [
    'Original request: "' + state.originalRequest + '"',
    "Destination: " + state.destination,
    "Category: " + c.primary_category + (c.secondary_category ? (" (secondary: " + c.secondary_category + ")") : ""),
    "Output format requested: " + (c.output_format || "auto"),
    "Stakes: " + c.stakes,
    ""
  ];
  lines.push("Interview answers (JSON):");
  lines.push(JSON.stringify(state.qaHistory.map(q => ({question:q.text, priority:q.priority||null, answer:q.answer}))));
  const skippedCritical = state.qaHistory.filter(q => q.priority === "critical" && q.answer && q.answer.startsWith("(skipped"));
  if (skippedCritical.length) {
    lines.push("");
    lines.push("IMPORTANT — the following CRITICAL questions were skipped, with the reason the person gave. Handle each according to its reason:");
    lines.push("- \"don't know yet\": make a clearly-labelled assumption and flag it — the person can correct it later.");
    lines.push("- \"not relevant to this task\": omit this topic entirely from the output — the person has told you it does not apply.");
    lines.push("- \"will fill in later\": note the gap explicitly so the person knows to complete it before using the prompt.");
    lines.push(JSON.stringify(skippedCritical.map(q => ({ question: q.text, reason: q.answer }))));
  }
  if ((c.stakes === "sensitive" || c.stakes === "professional") && state.requiredTopics.length){
    lines.push("");
    lines.push("Domain-risk topics flagged by the review step, with status (JSON):");
    lines.push(JSON.stringify(state.requiredTopics.map(t => ({
      label:t.label, reason:t.reason,
      status: t.dismissed ? "skipped (marked not applicable by the person)" : (t.covered ? "addressed during the interview" : "skipped (never asked)")
    }))));
  }
  if (c.contradictions && c.contradictions.length){
    lines.push("");
    lines.push("Contradictions in original request — check interview answers to see how the person resolved them:");
    lines.push(JSON.stringify(c.contradictions));
  }
  lines.push("");
  if (state.stagePlan){
    lines.push("Stage plan (JSON, ordered):");
    lines.push(JSON.stringify(state.stagePlan.stages));
  } else {
    lines.push("No staging — produce a single prompt.");
  }
  return lines.join("\n");
}

/* =====================================================================
   FLOW
   ===================================================================== */
function handleStartClick(){
  const input = document.getElementById("request-input");
  state.originalRequest = (input ? input.value : "").trim();
  if (!state.originalRequest){
    state.startError = "Type what you want to create first.";
    renderAll();
    return;
  }
  state.startError = null;
  // When limits are active and user is not signed in, prompt them to sign in first.
  if (!unrestrictedMode && !currentUser){
    openLogin();
    return;
  }
  runClassify();
}

async function runClassify(){
  funnelSessionId = crypto.randomUUID();
  state.screen = "classifying"; state.error = null; renderAll();
  try{
    const { text, usage } = await callGemini(CLASSIFY_SYSTEM, buildClassifyMsg(), CLASSIFY_SCHEMA, 500, false, FAST_MODEL);
    state.classification = parseJSON(text);
    logUsage("classify", FAST_MODEL, usage);
    state.screen = "classified";
    renderAll();
    const c = state.classification;
    fireFunnelEvent("classified", { category: c.primary_category, destination: state.destination, complexity: c.complexity });
    state._stampTimer = setTimeout(proceedFromClassification, 1200);
  } catch(e){
    state.error = { step:"classify", message:e.message };
    renderAll();
  }
}

function proceedFromClassification(){
  clearTimeout(state._stampTimer);
  const c = state.classification;
  if ((c.stakes === "sensitive" || c.stakes === "professional") && !state.considerationsDone){
    runConsiderations();
    return;
  }
  afterConsiderations();
}

function afterConsiderations(){
  runSelectQuestion();
}

async function runConsiderations(){
  state.screen = "considerations_loading"; state.error = null; renderAll();
  try{
    const { text, usage } = await callGemini(CONSIDERATIONS_SYSTEM, buildConsiderationsMsg(), CONSIDERATIONS_SCHEMA, 800, false, FAST_MODEL);
    const json = parseJSON(text);
    logUsage("considerations", FAST_MODEL, usage);
    state.requiredTopics = (json.required_topics || []).map(t => ({id:t.id, label:t.label, reason:t.reason, dismissed:false, covered:false}));
    state.considerationsDone = true;
    if (!state.requiredTopics.length){
      afterConsiderations();
    } else {
      state.screen = "considerations";
      renderAll();
    }
  } catch(e){
    state.error = { step:"considerations", message:e.message };
    renderAll();
  }
}

function continueAfterUpgrade(){
  if (state.gateReason === "big_task"){
    proceedFromClassification();
  } else {
    state.screen = "start"; renderAll();
  }
}

function toggleRequiredTopic(id){
  const t = state.requiredTopics.find(rt => rt.id === id);
  if (t) t.dismissed = !t.dismissed;
  renderAll();
}

async function runSelectQuestion(forceTopic){
  if (!forceTopic && state.qaHistory.length >= maxQuestions()){
    proceedAfterInterview();
    return;
  }
  state.screen = "loading_question"; state.error = null; renderAll();
  try{
    const sqModel = FAST_MODEL;
    const { text, usage } = await callGemini(SELECT_QUESTION_SYSTEM, buildSelectQuestionMsg(forceTopic), SELECT_QUESTION_SCHEMA, 800, false, sqModel);
    const json = parseJSON(text);
    logUsage("select_question", sqModel, usage);
    const pendingRequired = state.requiredTopics.filter(t => !t.dismissed && !t.covered);
    if ((json.action === "complete" || !json.next_question) && pendingRequired.length){
      if (forceTopic){
        // Already gave it one explicit chance to comply and it still tried to skip —
        // synthesize the question directly so coverage can never be silently dropped.
        state.currentQuestion = { id: forceTopic.id, text: "Tell us about: " + forceTopic.label,
          input_type: "free_text", options: null, hint: forceTopic.reason, covers_topic_id: forceTopic.id };
        state.multiSelections = [];
        state.customAnswerMode = false;
        state.freeTextDraft = "";
        state.screen = "interview";
        renderAll();
        return;
      }
      runSelectQuestion(pendingRequired[0]);
      return;
    }
    if (json.action === "complete" || !json.next_question){
      proceedAfterInterview();
    } else {
      if (state.qaHistory.length === 0) fireFunnelEvent("interview_started");
      state.currentQuestion = json.next_question;
      state.multiSelections = [];
      state.customAnswerMode = false;
      state.freeTextDraft = json.next_question.prefill || "";
      state.screen = "interview";
      renderAll();
    }
  } catch(e){
    state.error = { step:"select_question", message:e.message };
    renderAll();
  }
}

function submitAnswer(answerLabel){
  const q = state.currentQuestion;
  if (!answerLabel) return;
  state.qaHistory.push({id:q.id, text:q.text, input_type:q.input_type, priority:q.priority||null, covers_topic_id:q.covers_topic_id||null, answer:answerLabel, _question:q});
  if (q.covers_topic_id){
    const t = state.requiredTopics.find(rt => rt.id === q.covers_topic_id);
    if (t) t.covered = true;
  }
  state.currentQuestion = null;
  state.customAnswerMode = false;
  state.freeTextDraft = "";
  runSelectQuestion();
}

function proceedAfterInterview(){
  state.screen = "review";
  reviewEditIndex = null;
  reviewEditValue = "";
  renderAll();
}

function confirmGenerate(){
  fireFunnelEvent("interview_complete");
  const c = state.classification;
  if (c.complexity === "big") runStagePlanner(); else runGenerate();
}

async function runStagePlanner(){
  state.screen = "staging_loading"; state.error = null; renderAll();
  try{
    const { text, usage } = await callGemini(STAGE_PLANNER_SYSTEM, buildStagePlannerMsg(), STAGE_PLANNER_SCHEMA, 800, false, STRONG_MODEL);
    const rawPlan = parseJSON(text);
    if (rawPlan && rawPlan.stages) rawPlan.stages = rawPlan.stages.slice(0, 4);
    state.stagePlan = rawPlan;
    logUsage("plan_stages", STRONG_MODEL, usage);
    state.screen = "staged";
    renderAll();
  } catch(e){
    state.error = { step:"plan_stages", message:e.message };
    renderAll();
  }
}

async function runGenerate(){
  generateElapsed = 0;
  clearInterval(generateTimerInterval);
  generateTimerInterval = setInterval(function(){
    generateElapsed++;
    const el = document.getElementById("generate-timer");
    if (el) el.textContent = generateElapsed + "s…";
  }, 1000);
  state.screen = "generating_loading"; state.error = null; renderAll();
  try{
    const { text, usage } = await callGemini(GENERATE_SYSTEM, buildGenerateMsg(), GENERATE_SCHEMA, 8000, true, STRONG_MODEL);
    const json = parseJSON(text);
    state.finalResult = {
      assumptions: Array.isArray(json.assumptions) ? json.assumptions : [],
      elevatedStakesNotes: Array.isArray(json.elevated_stakes_notes) ? json.elevated_stakes_notes : [],
      prompts: (Array.isArray(json.prompts) ? json.prompts : []).map((p,i) => ({
        label: p.label || ("Prompt " + (i+1)),
        purpose: p.purpose || null,
        usage_notes: p.usage_notes || null,
        content: p.content || ""
      }))
    };
    clearInterval(generateTimerInterval); generateTimerInterval = null;
    logUsage("generate", STRONG_MODEL, usage);
    await finalizeSession();
    fireFunnelEvent("generated");
    state.screen = "result";
    renderAll();
    startTypewriter();
  } catch(e){
    clearInterval(generateTimerInterval); generateTimerInterval = null;
    state.error = { step:"generate", message:e.message };
    renderAll();
  }
}

async function finalizeSession(){
  currentRunId = await saveRun();
}

function regenerate(){
  state.finalResult = null;
  state.promptRating = null;
  state.resultsRating = null;
  state.feedbackComment = "";
  state.feedbackSent = false;
  runGenerate();
}

function retryLastStep(){
  if (!state.error) return;
  const step = state.error.step;
  state.error = null;
  if (step === "classify") runClassify();
  else if (step === "considerations") runConsiderations();
  else if (step === "select_question") runSelectQuestion();
  else if (step === "plan_stages") runStagePlanner();
  else if (step === "generate") runGenerate();
}

async function checkForUpdate(){
  try {
    const res = await fetch("/api/version");
    if (!res.ok) return;
    const { version } = await res.json();
    if (version && version !== APP_VERSION && !state.updateAvailable){
      state.updateAvailable = true;
      renderAll();
    }
  } catch(e){ /* network error — ignore */ }
}

// Check once after a short delay, then every 5 minutes.
// Only matters on the start screen; the flag persists so it'll show when the
// user gets back there even if it fired while they were mid-flow.
setTimeout(checkForUpdate, 3000);
setInterval(checkForUpdate, 5 * 60 * 1000);

function startOver(){
  clearTimeout(state._stampTimer);
  clearInterval(state._typeInterval);
  state = freshState();
  renderAll();
}

// Used when the person is blocked (e.g. the out-of-uses gate) rather than
// genuinely finished — their typed request was already captured into state
// by handleStartClick before the gate fired, so there's no reason to throw
// it away just because they're sent back to the start screen.
function backToStart(){
  clearTimeout(state._stampTimer);
  state.screen = "start";
  state.gateReason = null;
  state.error = null;
  renderAll();
}

/* =====================================================================
   RENDER
   ===================================================================== */
function esc(s){
  return String(s == null ? "" : s)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}


// textarea (which gets recreated every renderAll()) — this is what keeps
// typed text alive across re-renders triggered by unrelated clicks like
// switching destination/mode or toggling the ledger.
document.getElementById("app").addEventListener("input", function(e){
  if (e.target.id === "request-input") state.originalRequest = e.target.value;
  else if (e.target.id === "free-text-input") state.freeTextDraft = e.target.value;
  else if (e.target.id === "review-edit-input") reviewEditValue = e.target.value;
  else if (e.target.id === "fb-comment") state.feedbackComment = e.target.value;
  else if (e.target.id === "slider-input") {
    const num = document.getElementById("slider-live-num");
    if (num) num.textContent = e.target.value;
  }
});

document.getElementById("app").addEventListener("click", function(e){
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;
  switch(action){
    case "set-destination": state.destination = el.dataset.value; renderAll(); break;
    case "start": handleStartClick(); break;
    case "continue-after-classification": proceedFromClassification(); break;
    case "toggle-required-topic": toggleRequiredTopic(el.dataset.value); break;
    case "continue-after-considerations": afterConsiderations(); break;
    case "select-option": submitAnswer(el.dataset.value); break;
    case "use-custom-answer": state.customAnswerMode = true; renderAll(); break;
    case "use-suggested-options": state.customAnswerMode = false; renderAll(); break;
    case "toggle-multi": {
      const v = el.dataset.value;
      const idx = state.multiSelections.indexOf(v);
      if (idx === -1) state.multiSelections.push(v); else state.multiSelections.splice(idx,1);
      renderAll();
      break;
    }
    case "submit-multi": {
      if (!state.multiSelections.length){ renderAll(); break; }
      submitAnswer(state.multiSelections.join(", "));
      break;
    }
    case "submit-free-text": {
      const input = document.getElementById("free-text-input");
      const val = input ? input.value.trim() : "";
      if (val) submitAnswer(val);
      break;
    }
    case "submit-slider": {
      const input = document.getElementById("slider-input");
      submitAnswer((input ? input.value : "50") + "/100");
      break;
    }
    case "skip-question": state.showSkipReason = true; renderAll(); break;
    case "cancel-skip": state.showSkipReason = false; renderAll(); break;
    case "skip-reason": {
      const reasonMap = {
        "unknown":      "(skipped — I don't know yet)",
        "not_relevant": "(skipped — not relevant to this task)",
        "for_now":      "(skipped — will fill in later)"
      };
      state.showSkipReason = false;
      submitAnswer(reasonMap[el.dataset.value] || "(skipped)");
      break;
    }
    case "review-edit": {
      const i = parseInt(el.dataset.value, 10);
      reviewEditIndex = i;
      const cur = state.qaHistory[i].answer;
      reviewEditValue = cur === "(skipped)" ? "" : cur;
      renderAll();
      const ta = document.getElementById("review-edit-input");
      if (ta){ ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
      break;
    }
    case "review-cancel":
      reviewEditIndex = null; reviewEditValue = ""; renderAll(); break;
    case "review-save": {
      const i = parseInt(el.dataset.value, 10);
      const ta = document.getElementById("review-edit-input");
      const val = (ta ? ta.value : reviewEditValue).trim();
      if (val) state.qaHistory[i].answer = val;
      reviewEditIndex = null; reviewEditValue = "";
      renderAll(); break;
    }
    case "back-question": backQuestion(); break;
    case "hide-run": hideRun(el.dataset.value); break;
    case "collapse-stages": state.stagePlan = null; runGenerate(); break;
    case "edit-answers": state.screen = "review"; reviewEditIndex = null; reviewEditValue = ""; renderAll(); break;
    case "complete-typewriter": completeTypewriter(); break;
    case "confirm-generate": confirmGenerate(); break;
    case "regenerate": regenerate(); break;
    case "continue-after-staging": runGenerate(); break;
    case "retry": retryLastStep(); break;
    case "start-over": startOver(); break;
    case "refresh-to-update": window.location.reload(true); break;
    case "back-to-start": backToStart(); break;
    case "open-login": openLogin(); break;
    case "sign-out": signOut(); break;
    case "auth-google": signInWithGoogle(); break;
    case "auth-choose-signin":
      authView = "form"; authMode = "signin"; authError = null; authSuccess = null;
      refreshAuth(); break;
    case "auth-choose-signup":
      authView = "form"; authMode = "signup"; authError = null; authSuccess = null;
      refreshAuth(); break;
    case "auth-back":
      authView = "choice"; authError = null; authSuccess = null;
      refreshAuth(); break;
    case "auth-forgot":
      authView = "forgot"; authError = null; authSuccess = null;
      refreshAuth(); break;
    case "auth-back-to-signin":
      authView = "form"; authMode = "signin"; authError = null; authSuccess = null;
      refreshAuth(); break;
    case "auth-submit-forgot":
      forgotPasswordWithEmail(); break;
    case "auth-update-password":
      updatePassword(); break;
    case "auth-submit":
      if (authMode === "signup") signUpWithEmail(); else signInWithEmail();
      break;
    case "auth-toggle":
      authMode = (authMode === "signin") ? "signup" : "signin";
      authError = null; authSuccess = null;
      refreshAuth();
      break;
    case "toggle-dark": toggleDarkMode(); break;
    case "show-history": loadHistory(0); break;
    case "history-expand": {
      const rid = el.dataset.value;
      if (historyExpanded.has(rid)) historyExpanded.delete(rid); else historyExpanded.add(rid);
      renderAll();
      break;
    }
    case "history-copy": {
      const run = historyRuns.find(function(r){ return r.id === el.dataset.run; });
      const idx = parseInt(el.dataset.pidx, 10);
      const p = run && run.generated_prompts && run.generated_prompts.prompts && run.generated_prompts.prompts[idx];
      if (p) copyTextToClipboard(p.content).then(function(){ flashCopied(el); }).catch(function(){ flashCopyFailed(el); });
      break;
    }
    case "history-load-more": loadHistory(historyPage + 1); break;
    case "copy-prompt": copyPrompt(parseInt(el.dataset.value, 10)); break;
    case "copy-all": copyAllPrompts(); break;
    case "share-link": {
      const url = window.location.origin + "/share/" + currentRunId;
      copyTextToClipboard(url).then(function(){ el.textContent = "Copied!"; setTimeout(function(){ el.textContent = "Share link"; }, 2000); }).catch(function(){ el.textContent = "Copy failed"; setTimeout(function(){ el.textContent = "Share link"; }, 2000); });
      break;
    }
    case "shared-copy": {
      const idx = parseInt(el.dataset.value, 10);
      const p = sharedRun && sharedRun.generated_prompts && sharedRun.generated_prompts.prompts && sharedRun.generated_prompts.prompts[idx];
      if (p) copyTextToClipboard(p.content).then(function(){ el.textContent = "Copied!"; setTimeout(function(){ el.textContent = "Copy"; }, 2000); }).catch(function(){ flashCopyFailed(el); });
      break;
    }
    case "rating-prompt":  setPromptRating(parseInt(el.dataset.v, 10));  break;
    case "rating-results": setResultsRating(parseInt(el.dataset.v, 10)); break;
    case "submit-feedback": submitFeedback(); break;
    case "toggle-ledger": state.ledgerOpen = !state.ledgerOpen; renderAll(); break;
    case "toggle-decisions": state.decisionsOpen = !state.decisionsOpen; renderAll(); break;
  }
});

document.getElementById("topbar-right").addEventListener("click", function(e){
  const el = e.target.closest("[data-action]");
  if (!el) return;
  if (el.dataset.action === "start-over") startOver();
  else if (el.dataset.action === "open-login") openLogin();
  else if (el.dataset.action === "sign-out") signOut();
  else if (el.dataset.action === "show-history") loadHistory(0);
  else if (el.dataset.action === "toggle-dark") toggleDarkMode();
});

document.getElementById("auth-overlay").addEventListener("click", function(e){
  if (e.target === this) closeLogin();
});
window.addEventListener("online",  function(){ renderAll(); });
window.addEventListener("offline", function(){ renderAll(); });
document.addEventListener("keydown", function(e){
  if (e.key === "Escape") closeLogin();
});

initApp();
