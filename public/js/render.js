/* =====================================================================
   RENDER — all UI render functions
   ===================================================================== */
function renderReview(){
  const qa = state.qaHistory;
  let html = '<div class="stamp-wrap"><span class="stamp">Review your answers</span></div>' +
    '<p class="stamp-sub">Edit anything before we write your prompt — or just hit Generate.</p>' +
    '<div class="review-list">';

  qa.forEach(function(item, i){
    const isEditing = reviewEditIndex === i;
    const isSkipped = item.answer && item.answer.startsWith("(skipped");
    html += '<div class="review-row">';
    if (isEditing){
      html += '<div class="review-q">' + esc(item.text) + '</div>' +
        '<div class="review-edit-area">' +
          '<textarea id="review-edit-input">' + esc(reviewEditValue) + '</textarea>' +
          '<div class="review-edit-btns">' +
            '<button class="btn btn-primary btn-small" data-action="review-save" data-value="' + i + '">Save</button>' +
            '<button class="btn btn-small" data-action="review-cancel">Cancel</button>' +
          '</div>' +
        '</div>';
    } else {
      html += '<div class="review-row-head">' +
        '<div>' +
          '<div class="review-q">' + esc(item.text) + '</div>' +
          '<div class="review-a' + (isSkipped ? ' review-a-skipped' : (item.answer === '[AI DECIDES]' ? ' review-a-ai' : '')) + '">' +
            (item.answer === '[AI DECIDES]'
              ? '✦ AI will decide the best approach'
              : esc(isSkipped ? item.answer.replace(/^\(skipped — ?/, '').replace(/\)$/, '') + ' (skipped)' : item.answer)) +
          '</div>' +
        '</div>' +
        '<button class="review-edit-btn" data-action="review-edit" data-value="' + i + '">Edit</button>' +
      '</div>';
    }
    html += '</div>';
  });

  html += '</div>' +
    '<div class="btn-row" style="justify-content:center;">' +
      '<button class="btn btn-primary" data-action="confirm-generate">Generate prompt</button>' +
    '</div>';
  return html;
}

async function loadSharedRun(id){
  state.screen = "shared_loading";
  renderAll();
  try {
    const resp = await fetch("/api/share/" + id);
    if (!resp.ok) throw new Error("not found");
    sharedRun = await resp.json();
    state.screen = "shared";
  } catch(e){
    state.screen = "shared_error";
  }
  renderAll();
}

function renderSharedResult(){
  if (state.screen === "shared_loading") return renderLoading("Loading prompt…");
  if (state.screen === "shared_error"){
    return '<div class="stamp-wrap"><span class="stamp">Not Found</span></div>' +
      '<p class="stamp-sub" style="text-align:center;color:var(--muted);">This shared prompt doesn\'t exist or was removed.</p>' +
      '<div class="btn-row" style="justify-content:center;">' +
        '<a href="/" class="btn btn-primary" style="text-decoration:none;">Try Draft &amp; Stamp</a>' +
      '</div>';
  }
  const run = sharedRun;
  const prompts = (run.generated_prompts && run.generated_prompts.prompts) || [];
  const multi = prompts.length > 1;
  const destLabel = {claude:"Claude",chatgpt:"ChatGPT",gemini:"Gemini",grok:"Grok",perplexity:"Perplexity",deepseek:"DeepSeek",copilot:"Copilot",midjourney:"Midjourney",general:"General"}[run.destination] || run.destination || "";
  const catLabel = (run.category || "").replace(/_/g," ");

  let html = '<div class="stamp-wrap"><span class="stamp green">Approved</span></div>';
  html += '<div class="shared-header">' +
    '<p class="shared-request">' + esc(run.request || "") + '</p>' +
    '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
      (destLabel ? '<span class="history-dest-chip">' + esc(destLabel) + '</span>' : '') +
      (catLabel  ? '<span class="history-cat-chip">' + esc(catLabel) + '</span>'  : '') +
    '</div>' +
  '</div>';

  if (multi){
    html += '<p class="staged-order-note">Use these prompts in order, inside the same conversation — do not start a new chat between steps.</p>';
  }

  html += '<div class="prompt-cards">' + prompts.map((p, i) =>
    '<div class="prompt-card">' +
      '<div class="prompt-card-head">' +
        '<div>' +
          '<div class="prompt-card-label">' + esc(p.label) + '</div>' +
          (p.purpose ? '<div class="prompt-card-purpose">' + esc(p.purpose) + '</div>' : '') +
        '</div>' +
        '<button class="btn btn-small prompt-copy-btn" data-action="shared-copy" data-value="' + i + '">Copy</button>' +
      '</div>' +
      '<div class="output-block"><pre class="output-text">' + esc(p.content) + '</pre></div>' +
    '</div>'
  ).join("") + '</div>';

  html += '<div class="shared-footer">' +
    '<p>Crafted with <strong>Draft &amp; Stamp</strong> — turn any idea into a prompt that actually works.</p>' +
    '<div class="btn-row" style="justify-content:center;margin-top:14px;">' +
      '<a href="/" class="btn btn-primary" style="text-decoration:none;">Create your own</a>' +
    '</div>' +
  '</div>';

  return html;
}

function renderProgress(){
  const s = state.screen;
  let step;
  if (["classifying","classified","considerations_loading","considerations"].includes(s)) step = 1;
  else if (["loading_question","interview","review"].includes(s)) step = 2;
  else if (["staging_loading","staged","generating_loading","result"].includes(s)) step = 3;
  else return "";
  const labels = ["Classify","Interview","Generate"];
  let html = '<div class="pipeline-progress">';
  labels.forEach(function(label, i){
    const n = i + 1;
    const cls = n < step ? "done" : n === step ? "active" : "";
    html += '<div class="pp-step ' + cls + '"><div class="pp-dot"></div><div class="pp-label">' + label + '</div></div>';
    if (i < 2) html += '<div class="pp-line' + (n < step ? " done" : "") + '"></div>';
  });
  return html + '</div>';
}

function toggleDarkMode(){
  darkMode = !darkMode;
  localStorage.setItem("darkMode", darkMode);
  document.body.classList.toggle("dark", darkMode);
  renderTopbar();
}

function onHistorySearch(val){
  historySearch = val;
  clearTimeout(historySearchTimer);
  historySearchTimer = setTimeout(function(){ loadHistory(0); }, 350);
}

async function loadHistory(pageNum){
  historyLoading = true;
  if (pageNum === 0){ historyRuns = []; historyExpanded = new Set(); }
  state.screen = "history";
  renderAll();
  try{
    const session = await sbClient.auth.getSession();
    const token = session.data.session && session.data.session.access_token;
    let url = "/api/runs?page=" + pageNum;
    if (historySearch.trim()) url += "&q=" + encodeURIComponent(historySearch.trim());
    const resp = await fetch(url, {
      headers: token ? { "Authorization": "Bearer " + token } : {}
    });
    const json = await resp.json();
    if (pageNum === 0) historyRuns = json.runs || [];
    else historyRuns = historyRuns.concat(json.runs || []);
    historyPage = pageNum;
    historyTotal = json.total || 0;
  } catch(e){ console.error("loadHistory:", e); }
  historyLoading = false;
  renderAll();
}

function renderHistory(){
  if (historyLoading && historyRuns.length === 0){
    return renderLoading("Loading your prompts…");
  }
  const destLabels = {
    claude:"Claude",chatgpt:"ChatGPT",gemini:"Gemini",grok:"Grok",
    perplexity:"Perplexity",deepseek:"DeepSeek",copilot:"Copilot",
    midjourney:"Midjourney",general:"General"
  };
  let html = '<div class="history-header">' +
    '<h2 class="history-title">My Prompts</h2>' +
    '<p class="history-sub">' + (historyTotal ? historyTotal + " run" + (historyTotal !== 1 ? "s" : "") + (historySearch.trim() ? " matching &ldquo;" + esc(historySearch.trim()) + "&rdquo;" : " saved") : "Your saved prompts appear here") + '</p>' +
  '</div>' +
  '<input type="search" class="history-search" placeholder="Search prompts…" value="' + esc(historySearch) + '" oninput="onHistorySearch(this.value)">';

  const visibleRuns = historyRuns.filter(r => !hiddenRunIds.has(r.id));
  if (!historyLoading && visibleRuns.length === 0){
    const allHidden = historyRuns.length > 0 && historyRuns.every(r => hiddenRunIds.has(r.id));
    html += '<div class="history-empty">' + (allHidden ? 'All prompts removed from view.' : 'No runs yet — start drafting to see your history here.') + '</div>';
    html += '<div class="btn-row"><button class="btn" data-action="start-over">Start drafting</button></div>';
    return html;
  }
  html += '<div class="history-list">';
  visibleRuns.forEach(function(run){
    const isExpanded = historyExpanded.has(run.id);
    const d = new Date(run.created_at);
    const dateStr = d.toLocaleDateString("en-US",{day:"numeric",month:"short",year:"numeric"});
    const timeStr = d.toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit"});
    const dest = run.destination || "general";
    const destLabel = destLabels[dest] || dest;
    const category = (run.category || "").replace(/_/g," ");
    const prompts = (run.generated_prompts && run.generated_prompts.prompts) ? run.generated_prompts.prompts : [];
    const promptCount = prompts.length;

    html += '<div class="history-card">' +
      '<div style="display:flex;align-items:flex-start;gap:6px;">' +
      '<div class="history-card-top" data-action="history-expand" data-value="' + esc(run.id) + '" style="flex:1;min-width:0;">' +
        '<div class="history-card-meta">' +
          '<span class="history-dest-chip">' + esc(destLabel) + '</span>' +
          (category ? '<span class="history-cat-chip">' + esc(category) + '</span>' : '') +
          '<span class="history-date">' + esc(dateStr) + ' · ' + esc(timeStr) + '</span>' +
        '</div>' +
        '<div class="history-card-request">' + esc(run.request || "") + '</div>' +
        '<div class="history-card-toggle">' + (isExpanded ? '↑ Collapse' : '↓ Show ' + (promptCount === 1 ? '1 prompt' : promptCount + ' prompts')) + '</div>' +
      '</div>' +
      '<button data-action="hide-run" data-value="' + esc(run.id) + '" title="Remove from history" style="flex-shrink:0;background:none;border:none;color:var(--muted);font-size:1.1rem;cursor:pointer;padding:4px 6px;line-height:1;border-radius:3px;opacity:0.5;" onmouseover="this.style.opacity=\'1\'" onmouseout="this.style.opacity=\'0.5\'">×</button>' +
      '</div>';

    if (isExpanded && promptCount){
      html += '<div class="history-card-prompts">';
      prompts.forEach(function(p, i){
        html += '<div>' +
          '<div class="history-prompt-head">' +
            '<div class="history-prompt-label">' + esc(p.label) + '</div>' +
            '<button class="btn btn-small prompt-copy-btn" data-action="history-copy" data-run="' + esc(run.id) + '" data-pidx="' + i + '">Copy</button>' +
          '</div>' +
          (p.purpose ? '<div class="history-prompt-purpose">' + esc(p.purpose) + '</div>' : '') +
          '<div class="output-block"><pre class="output-text" id="hprompt-' + esc(run.id) + '-' + i + '">' + esc(p.content) + '</pre></div>' +
        '</div>';
      });
      html += '</div>';
    }
    html += '</div>';
  });
  html += '</div>';

  if (historyRuns.length < historyTotal){
    html += '<div class="btn-row" style="justify-content:center;margin-bottom:4px;">' +
      '<button class="btn" data-action="history-load-more">' + (historyLoading ? 'Loading…' : 'Load more') + '</button>' +
    '</div>';
  }
  html += '<div class="btn-row"><button class="btn" data-action="start-over">Start a new prompt</button></div>';
  return html;
}

function renderTopbar(){
  let html = '';
  if (currentUser){
    if (unrestrictedMode) html += '<span class="chip">Beta &middot; unlimited</span>';
    html += '<span class="chip">' + esc(currentUser.email) + '</span>';
    html += '<span class="topbar-sep"></span>';
    html += '<button class="topbar-btn" data-action="show-history">My prompts</button>';
    if (isAdmin) html += '<a href="/admin" class="btn btn-primary" style="padding:5px 13px;font-size:0.8rem;text-decoration:none;">Admin</a>';
    html += '<span class="topbar-sep"></span>';
    html += '<button class="topbar-btn" data-action="sign-out">Sign out</button>';
    html += '<button class="topbar-btn" data-action="start-over">Start over</button>';
    html += '<span class="topbar-sep"></span>';
  }
  html += '<button class="topbar-btn" data-action="toggle-dark">' + (darkMode ? 'Light' : 'Dark') + '</button>';
  const el = document.getElementById("topbar-right");
  if (el.innerHTML !== html) el.innerHTML = html;
}

function destinationPills(){
  const opts = [["claude","Claude"],["chatgpt","ChatGPT"],["gemini","Gemini"],["grok","Grok"],
    ["perplexity","Perplexity"],["deepseek","DeepSeek"],["copilot","Microsoft Copilot"],
    ["midjourney","Midjourney"],["general","General"]];
  return '<div class="pill-row">' + opts.map(o =>
    '<button class="pill-btn ' + (state.destination===o[0]?"selected":"") + '" data-action="set-destination" data-value="' + o[0] + '">' + esc(o[1]) + '</button>'
  ).join("") + '</div>';
}


function renderStart(){
  const updateBanner = state.updateAvailable
    ? '<div class="update-banner">' +
        '<span class="update-banner-text">A newer version of Draft &amp; Stamp is available.</span>' +
        '<button class="update-banner-btn" data-action="refresh-to-update">Refresh to update</button>' +
      '</div>'
    : '';
  return updateBanner +
    '<h1 class="title">Draft &amp; Stamp</h1>' +
    '<p style="font-style:italic;color:var(--muted);font-size:0.95rem;margin:2px 0 18px;">your personal prompt engineer</p>' +
    '<p class="subtitle">Turn a rough idea into a precise prompt another AI can actually use.</p>' +
    '<p class="meta-caption">Built straight from this project\'s own pipeline spec: classify &rarr; ask &rarr; stage &rarr; write.</p>' +
    '<label class="field-label" for="request-input">What do you want to create?</label>' +
    '<textarea id="request-input" placeholder="e.g. a tweet about our new coffee blend, or a financial model for a seed round">' + esc(state.originalRequest) + '</textarea>' +
    (state.startError ? '<div class="start-error">' + esc(state.startError) + '</div>' : '') +
    '<label class="field-label">Where will you paste this prompt?</label>' +
    destinationPills() +
    '<div class="btn-row"><button class="btn btn-primary" data-action="start">Start drafting</button></div>';
}

function renderLoading(line){
  return '<p class="loading-line">' + esc(line) + '<span class="cursor">▌</span></p>';
}

function renderClassified(){
  const c = state.classification;
  const label = c.primary_category.replace(/_/g," ") + (c.secondary_category ? (" + " + c.secondary_category.replace(/_/g," ")) : "");
  const stakesNote = c.stakes === "sensitive" ? " &middot; flagged for review" : c.stakes === "professional" ? " &middot; professional output" : "";
  let html = '<div class="stamp-wrap"><span class="stamp">Filed &middot; ' + esc(label) + ' &middot; ' + esc(c.complexity) + stakesNote + '</span></div>' +
    '<p class="stamp-sub">' + (c.reasoning ? esc(c.reasoning) : "Got it — figuring out the best next step.") + '</p>';
  if (c.contradictions && c.contradictions.length){
    html += '<div class="note-panel note-stakes" style="margin-bottom:12px;">' +
      '<div class="note-panel-title">Conflicting requirements detected</div>' +
      '<ul class="note-list">' + c.contradictions.map(ct => '<li>' + esc(ct) + '</li>').join("") + '</ul>' +
    '</div>';
  }
  html += '<div class="btn-row" style="justify-content:center;"><button class="btn" data-action="continue-after-classification">Continue</button></div>';
  return html;
}

function renderGate(){
  return '' +
    '<div class="gate-icon">&#9863;</div>' +
    '<h1 class="title" style="text-align:center;font-size:1.5rem;">Sign in to continue</h1>' +
    '<p class="subtitle" style="text-align:center;">Create a free account to keep using Draft &amp; Stamp.</p>' +
    '<div class="btn-row" style="justify-content:center;">' +
      '<button class="btn btn-primary" data-action="open-login">Sign in / Sign up</button>' +
      '<button class="btn" data-action="back-to-start">Back</button>' +
    '</div>';
}

function renderConsiderations(){
  const topics = state.requiredTopics;
  const isProfessional = state.classification && state.classification.stakes === "professional";
  const stampLabel = isProfessional ? "Client-facing &middot; " + topics.length + " to cover" : "Flagged &middot; " + topics.length + " to cover";
  const subText = isProfessional
    ? "This is going to an external audience, so a quick expert pass flagged a few things that tend to matter for professional outputs. Uncheck anything that genuinely doesn’t apply."
    : "This touches a regulated or high-stakes area, so a quick expert pass came back with a few things worth nailing down. Anything that genuinely doesn’t apply, mark below — everything left checked will get asked about during the interview.";
  return '' +
    '<div class="stamp-wrap"><span class="stamp amber">' + stampLabel + '</span></div>' +
    '<p class="stamp-sub">' + subText + '</p>' +
    '<ul class="topic-list">' + topics.map(t =>
      '<li class="topic-row ' + (t.dismissed?"dismissed":"") + '" data-action="toggle-required-topic" data-value="' + esc(t.id) + '">' +
        '<span class="check-box ' + (t.dismissed?"":"on") + '">' + (t.dismissed?"":"✓") + '</span>' +
        '<div><div class="topic-label">' + esc(t.label) + '</div><div class="topic-reason">' + esc(t.reason) + '</div></div>' +
      '</li>'
    ).join("") + '</ul>' +
    '<div class="btn-row" style="justify-content:center;">' +
      '<button class="btn btn-primary" data-action="continue-after-considerations">Continue</button>' +
    '</div>';
}

function renderCustomToggle(q){
  if (q.input_type === "free_text") return "";
  return '<button class="custom-toggle" data-action="use-custom-answer">Type your own answer instead</button>';
}

function renderOptionInput(q){
  if (state.customAnswerMode && q.input_type !== "free_text"){
    return '<textarea id="free-text-input" class="free-text-input" placeholder="Type your answer…">' + esc(state.freeTextDraft) + '</textarea>' +
      '<div class="btn-row"><button class="btn btn-primary" data-action="submit-free-text">Continue</button></div>' +
      '<button class="custom-toggle" data-action="use-suggested-options">Back to suggested options</button>';
  }
  if (q.input_type === "single_select"){
    const opts = q.options || [];
    if (!opts.length) {
      // Model picked single_select but sent no options — fall back to free text
      return '<textarea id="free-text-input" class="free-text-input" placeholder="Type your answer…">' + esc(state.freeTextDraft) + '</textarea>' +
        '<div class="btn-row"><button class="btn btn-primary" data-action="submit-free-text">Continue</button></div>';
    }
    return '<div class="option-stack">' + opts.map(o =>
      '<button class="option-btn" data-action="select-option" data-value="' + esc(o.label) + '">' +
        '<span class="option-label">' + esc(o.label) + '</span>' +
        (o.example ? '<span class="option-example">' + esc(o.example) + '</span>' : '') +
      '</button>'
    ).join("") + '</div>' + renderCustomToggle(q);
  }
  if (q.input_type === "multi_select"){
    const opts = q.options || [];
    if (!opts.length) {
      return '<textarea id="free-text-input" class="free-text-input" placeholder="Type your answer…">' + esc(state.freeTextDraft) + '</textarea>' +
        '<div class="btn-row"><button class="btn btn-primary" data-action="submit-free-text">Continue</button></div>';
    }
    return '<div class="option-stack">' + opts.map(o => {
      const on = state.multiSelections.includes(o.label);
      return '<div class="check-row" data-action="toggle-multi" data-value="' + esc(o.label) + '">' +
        '<span class="check-box ' + (on?"on":"") + '">' + (on?"✓":"") + '</span>' +
        '<span class="option-label">' + esc(o.label) + '</span>' +
      '</div>';
    }).join("") + '</div>' +
    '<div class="btn-row"><button class="btn btn-primary" data-action="submit-multi">Continue</button></div>' +
    renderCustomToggle(q);
  }
  if (q.input_type === "slider"){
    const lo = (q.options && q.options[0] && q.options[0].label) || "Less";
    const hi = (q.options && q.options[q.options.length-1] && q.options[q.options.length-1].label) || "More";
    return '<div class="slider-row">' +
      '<div class="slider-live">' +
        '<div class="slider-live-num" id="slider-live-num">50</div>' +
        '<div class="slider-live-sub">out of 100 — drag to adjust</div>' +
      '</div>' +
      '<input type="range" id="slider-input" min="0" max="100" value="50">' +
      '<div class="slider-labels"><span>' + esc(lo) + '</span><span>' + esc(hi) + '</span></div>' +
    '</div>' +
    '<div class="btn-row"><button class="btn btn-primary" data-action="submit-slider">Continue</button></div>' +
    renderCustomToggle(q);
  }
  // free_text — show a prefill note if the value was inferred from context
  const hasPrefill = q.prefill && state.freeTextDraft === q.prefill;
  return (hasPrefill ? '<p class="prefill-note">Inferred from your request — edit if anything\'s off.</p>' : '') +
    '<textarea id="free-text-input" class="free-text-input" placeholder="Type your answer…">' + esc(state.freeTextDraft) + '</textarea>' +
    '<div class="btn-row"><button class="btn btn-primary" data-action="submit-free-text">Confirm</button></div>' +
    '<button class="custom-toggle ai-decide-btn" data-action="ai-decides">✦ Let AI choose the best approach for me</button>';
}

function renderInterview(){
  const q = state.currentQuestion;
  const pending = state.requiredTopics.filter(t => !t.dismissed && !t.covered);
  const isCritical = q.priority === "critical";
  const isFirst = state.qaHistory.length === 0;
  let html = '';
  if (isFirst){
    html += '<p class="stamp-sub" style="margin-bottom:4px;">I\'ll ask a few questions to build your prompt — starting with the most important ones.</p>';
  }
  const isBig = state.classification && state.classification.complexity === "big";
  const softCap = isBig ? bigCritCap + 1 : smallCritCap + 1;
  const isAlmostDone = state.qaHistory.length >= softCap - 1;
  const progressLabel = isAlmostDone
    ? '<div class="progress-note" style="color:var(--green);">Almost done — wrapping up</div>'
    : '<div class="progress-note">' + state.qaHistory.length + ' decision' + (state.qaHistory.length===1?"":"s") + ' logged so far</div>';
  html += progressLabel +
    (pending.length ? '<div class="pending-topics">Still need to cover: ' + pending.map(t => esc(t.label)).join(", ") + '</div>' : '') +
    (isCritical ? '<div class="question-priority-badge">Key detail</div>' : '') +
    '<p class="question-text">' + esc(q.text) + '</p>' +
    (q.hint ? '<p class="question-hint">' + esc(q.hint) + '</p>' : '') +
    renderOptionInput(q) +
    (state.showSkipReason
      ? '<div class="skip-reason-box">' +
          '<p class="skip-reason-label">Why are you skipping?</p>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
            '<button class="skip-btn" data-action="skip-reason" data-value="unknown">I don\'t know yet</button>' +
            '<button class="skip-btn" data-action="skip-reason" data-value="not_relevant">Not relevant to this</button>' +
            '<button class="skip-btn" data-action="skip-reason" data-value="for_now">Skip for now</button>' +
            '<button class="skip-btn" data-action="cancel-skip" style="opacity:0.5;">Cancel</button>' +
          '</div>' +
        '</div>'
      : '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:2px;">' +
          '<button class="skip-btn" data-action="skip-question">Skip this question</button>' +
          (state.qaHistory.length ? '<button class="skip-btn" data-action="back-question" style="opacity:0.6;">← Undo last answer</button>' : '') +
        '</div>'
    );
  if (state.qaHistory.length){
    html += '<button class="decisions-toggle" data-action="toggle-decisions">' + (state.decisionsOpen?"Hide":"Show") + ' decisions so far</button>';
    if (state.decisionsOpen){
      html += '<div class="decisions-log">' + state.qaHistory.map(item =>
        '<div class="decision-row"><span class="decision-tick">✓</span><span><span class="decision-q">' + esc(item.text) + '</span> — <span class="decision-a' + (item.answer === '[AI DECIDES]' ? ' decision-a-ai' : '') + '">' + (item.answer === '[AI DECIDES]' ? '✦ AI decides' : esc(item.answer)) + '</span></span></div>'
      ).join("") + '</div>';
    }
  }
  return html;
}

function renderStaged(){
  const plan = state.stagePlan;
  const n = plan.stages.length;
  const single = plan.collapsed_to_single || n <= 1;
  const stampText = single ? "One part" : "Staged · " + n + " parts";
  const sub = single ? "Turned out simple enough for a single prompt." : "Big enough to split into stages.";
  return '' +
    '<div class="stamp-wrap"><span class="stamp">' + esc(stampText) + '</span></div>' +
    '<p class="stamp-sub">' + esc(sub) + '</p>' +
    '<ul class="stage-list">' + plan.stages.map((s,i) =>
      '<li class="stage-item"><span class="stage-num">0' + (i+1) + '</span><div><div class="stage-title">' + esc(s.title) + '</div><div class="stage-purpose">' + esc(s.purpose) + '</div></div></li>'
    ).join("") + '</ul>' +
    '<div class="btn-row" style="justify-content:center;">' +
      '<button class="btn btn-primary" data-action="continue-after-staging">Write the prompt' + (single?"":"s") + '</button>' +
      (!single ? '<button class="btn" data-action="collapse-stages" style="font-size:0.85rem;">Combine into one prompt instead</button>' : '') +
    '</div>';
}

function renderResult(){
  const r = state.finalResult;
  const multi = r.prompts.length > 1;
  const destLabels = {claude:"Claude",chatgpt:"ChatGPT",gemini:"Gemini",grok:"Grok",perplexity:"Perplexity",deepseek:"DeepSeek",copilot:"Microsoft Copilot",midjourney:"Midjourney",general:"General"};
  const destName = destLabels[state.destination] || (state.destination ? state.destination.charAt(0).toUpperCase() + state.destination.slice(1) : "your AI tool");
  let html = '<div class="stamp-wrap"><span class="stamp green">Approved</span></div>';

  if (r.assumptions.length){
    html += '<div class="note-panel note-assumptions">' +
      '<div class="note-panel-title">Assumptions made — worth a quick check</div>' +
      '<ul class="note-list">' + r.assumptions.map(a => '<li>' + esc(a) + '</li>').join("") + '</ul>' +
    '</div>';
  }

  if (multi){
    html += '<p class="staged-order-note">Use these prompts in order, inside the same conversation — do not start a new chat between steps.</p>';
  }

  const copyDisabled = !typewriterDone;
  html += '<p style="font-size:0.85rem;color:var(--muted);margin:0 0 14px;">Copy ' + (multi ? 'each prompt below and paste it' : 'the prompt below and paste it') + ' into <strong>' + esc(destName) + '</strong> to get your output.</p>';
  html += (copyDisabled ? '<p style="font-size:0.8rem;color:var(--muted);text-align:center;margin:0 0 10px;cursor:pointer;" data-action="complete-typewriter">Generating… click anywhere to reveal</p>' : '');
  html += '<div class="prompt-cards" ' + (copyDisabled ? 'data-action="complete-typewriter" style="cursor:pointer;"' : '') + '>' + r.prompts.map((p,i) =>
    '<div class="prompt-card">' +
      '<div class="prompt-card-head">' +
        '<div>' +
          '<div class="prompt-card-label">' + esc(p.label) + '</div>' +
          (p.purpose ? '<div class="prompt-card-purpose">' + esc(p.purpose) + '</div>' : '') +
        '</div>' +
        '<button class="btn btn-small prompt-copy-btn" data-action="copy-prompt" data-value="' + i + '"' + (copyDisabled ? ' disabled style="opacity:0.4;"' : '') + '>Copy prompt</button>' +
      '</div>' +
      (p.usage_notes ? '<div class="usage-notes-bar">' + esc(p.usage_notes) + '</div>' : '') +
      '<div class="output-block"><pre class="output-text" id="prompt-text-' + i + '">' + esc(p.content) + '</pre></div>' +
    '</div>'
  ).join("") + '</div>';

  if (multi){
    html += '<div class="btn-row" style="justify-content:center;"><button class="btn" id="copy-all-btn" data-action="copy-all">Copy all, in order</button></div>';
  }

  if (r.elevatedStakesNotes.length){
    html += '<div class="note-panel note-stakes">' +
      '<div class="note-panel-title">Worth double-checking before you use this</div>' +
      '<ul class="note-list">' + r.elevatedStakesNotes.map(n => '<li>' + esc(n) + '</li>').join("") + '</ul>' +
    '</div>';
  }

  html += '' +
    (currentUser
      ? '<p class="cost-line">Saved &middot; ' + esc(currentUser.email) + (currentRunId ? ' <button class="share-btn" data-action="share-link">Share link</button>' : '') + '</p>'
      : '<p class="cost-line"><button class="link-btn" style="color:var(--muted);" data-action="open-login">Sign in to save your prompts across sessions</button></p>') +
    (state.feedbackSent
      ? '<div class="feedback-block"><p style="color:var(--green);font-size:0.9rem;margin:0;">Thanks for the feedback — it helps us improve.</p></div>'
      : '<div class="feedback-block">' +
          '<div class="fb-section">' +
            '<div class="fb-section-label">Prompt quality</div>' +
            '<div class="fb-pills">' +
              [1,2,3,4,5,6,7,8,9,10].map(n =>
                '<button class="fb-pill' + (state.promptRating === n ? ' sel' : '') + '" data-action="rating-prompt" data-group="prompt" data-v="' + n + '">' + n + '</button>'
              ).join("") +
            '</div>' +
            '<div class="fb-hint"><span>Needs work</span><span>Perfect</span></div>' +
          '</div>' +
          '<div class="fb-section">' +
            '<div class="fb-section-label">Results quality</div>' +
            '<div class="fb-pills">' +
              [1,2,3,4,5,6,7,8,9,10].map(n =>
                '<button class="fb-pill' + (state.resultsRating === n ? ' sel' : '') + '" data-action="rating-results" data-group="results" data-v="' + n + '">' + n + '</button>'
              ).join("") +
            '</div>' +
            '<div class="fb-hint"><span>Didn\'t help</span><span>Nailed it</span></div>' +
          '</div>' +
          '<div class="fb-section">' +
            '<div class="fb-section-label">Tell us more <span style="font-weight:400;text-transform:none;letter-spacing:0;">(optional)</span></div>' +
            '<textarea id="fb-comment" class="fb-textarea" placeholder="What worked, what didn\'t, anything we should know…">' + esc(state.feedbackComment) + '</textarea>' +
          '</div>' +
          '<div class="fb-submit"><button class="btn btn-primary" data-action="submit-feedback">Send feedback</button></div>' +
        '</div>') +
    '<button class="ledger-toggle" data-action="toggle-ledger">' + (state.ledgerOpen?"Hide":"Show") + ' what happened behind the scenes</button>' +
    (state.ledgerOpen ? renderLedger() : '') +
    '<div class="btn-row">' +
      '<button class="btn" data-action="regenerate">Regenerate</button>' +
      (state.qaHistory.length ? '<button class="btn" data-action="edit-answers">Edit answers</button>' : '') +
      '<button class="btn" data-action="start-over">Start a new prompt</button>' +
    '</div>';

  return html;
}

function renderLedger(){
  return '<table class="ledger-table"><thead><tr><th>Step</th><th>Model</th><th>In</th><th>Out</th></tr></thead><tbody>' +
    state.usageEvents.map(e => '<tr><td>' + esc(e.step) + '</td><td>' + esc(e.model) + '</td><td>' + e.input_tokens + '</td><td>' + e.output_tokens + '</td></tr>').join("") +
    '</tbody></table>';
}

function renderErrorBanner(){
  if (!state.error) return '';
  const msg = state.error.message || "";
  const isNetwork  = msg === "network_failure";
  const isTimeout  = msg === "timeout_failure";
  const isCapacity = !isNetwork && !isTimeout && (msg.includes("All API keys") || msg.includes("daily limit") || msg.includes("high demand") || msg.includes("overloaded"));
  const heading = isNetwork  ? "Connection problem"
                : isTimeout  ? "Request timed out"
                : isCapacity ? "Service temporarily at capacity"
                :              "Something went wrong";
  const errBody = isNetwork  ? "Looks like a network issue — check your Wi-Fi or mobile data and try again. Your progress is saved."
               : isTimeout  ? "The AI service took too long to respond — this usually fixes itself. Hit Try again; your progress is saved."
               : isCapacity ? "We're handling a lot of requests right now. Wait a moment and hit Retry — your progress is saved."
               : msg;
  const retryLabel = isCapacity ? "Retry" : "Try again";
  return '<div class="error-banner"><strong>' + esc(heading) + '</strong><p style="margin:6px 0 12px;">' + esc(errBody) + '</p>' +
    '<div class="btn-row"><button class="btn btn-primary" data-action="retry">' + retryLabel + '</button><button class="btn" data-action="start-over">Start over</button></div></div>';
}

function authChoiceHTML(includeClose){
  const googleSvg = '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/><path d="M9 18c2.43 0 4.467-.806 5.956-2.18L12.048 13.56c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z" fill="#34A853"/><path d="M3.964 10.71c-.18-.54-.282-1.117-.282-1.71s.102-1.17.282-1.71V4.958H.957C.347 6.173 0 7.548 0 9s.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/><path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/></svg>';
  return (includeClose ? '<button class="auth-close" id="auth-close-btn">&#x2715;</button>' : '') +
    '<h2 class="auth-title">Welcome</h2>' +
    '<p class="auth-sub">Free during beta — save your prompts across sessions.</p>' +
    (authError ? '<div class="auth-msg auth-error">' + esc(authError) + '</div>' : '') +
    '<button class="auth-google-btn" data-action="auth-google">' + googleSvg + ' Continue with Google</button>' +
    '<div class="auth-divider"><span style="flex:1;height:1px;background:var(--paper-line);display:block;"></span><span>or</span><span style="flex:1;height:1px;background:var(--paper-line);display:block;"></span></div>' +
    '<button class="btn btn-primary" data-action="auth-choose-signin" style="width:100%;margin-bottom:10px;">Sign in with email</button>' +
    '<button class="btn" data-action="auth-choose-signup" style="width:100%;">Create account</button>';
}

function authFormHTML(isSignUp, includeClose){
  return (includeClose ? '<button class="auth-close" id="auth-close-btn">&#x2715;</button>' : '') +
    '<h2 class="auth-title">' + (isSignUp ? "Create account" : "Sign in") + '</h2>' +
    '<p class="auth-sub">Free during beta — save your prompts across sessions.</p>' +
    (authSuccess ? '<div class="auth-msg auth-success">' + esc(authSuccess) + '</div>' : '') +
    (authError   ? '<div class="auth-msg auth-error">'   + esc(authError)   + '</div>' : '') +
    '<input type="email" id="auth-email" class="auth-input" placeholder="Email" autocomplete="email">' +
    '<div class="auth-pw-wrap">' +
      '<input type="password" id="auth-password" class="auth-input" placeholder="Password (6+ chars)" autocomplete="' + (isSignUp ? 'new-password' : 'current-password') + '">' +
      '<button type="button" class="auth-pw-toggle" id="auth-pw-toggle" tabindex="-1">Show</button>' +
    '</div>' +
    '<button class="btn btn-primary" data-action="auth-submit" style="width:100%;margin-top:4px;" ' + (authLoading ? 'disabled' : '') + '>' +
      (authLoading ? 'Please wait…' : (isSignUp ? 'Create account' : 'Sign in')) +
    '</button>' +
    (!isSignUp ? '<button class="auth-toggle" data-action="auth-forgot" style="font-size:0.8rem;margin-top:6px;">Forgot password?</button>' : '') +
    '<button class="auth-toggle" data-action="auth-toggle">' +
      (isSignUp ? "Already have an account? Sign in" : "No account yet? Sign up free") +
    '</button>' +
    '<button class="auth-toggle" data-action="auth-back" style="margin-top:6px;">← Back to options</button>';
}

function authForgotHTML(includeClose){
  return (includeClose ? '<button class="auth-close" id="auth-close-btn">&#x2715;</button>' : '') +
    '<h2 class="auth-title">Reset password</h2>' +
    '<p class="auth-sub">Enter your email and we\'ll send you a reset link.</p>' +
    (authSuccess ? '<div class="auth-msg auth-success">' + esc(authSuccess) + '</div>' : '') +
    (authError   ? '<div class="auth-msg auth-error">'   + esc(authError)   + '</div>' : '') +
    '<input type="email" id="auth-email" class="auth-input" placeholder="Email" autocomplete="email">' +
    '<button class="btn btn-primary" data-action="auth-submit-forgot" style="width:100%;margin-top:4px;" ' + (authLoading ? 'disabled' : '') + '>' +
      (authLoading ? 'Sending…' : 'Send reset link') +
    '</button>' +
    '<button class="auth-toggle" data-action="auth-back-to-signin" style="margin-top:6px;">← Back to sign in</button>';
}

function wireAuthForgot(){
  const closeBtn = document.getElementById("auth-close-btn");
  const emailField = document.getElementById("auth-email");
  if (closeBtn) closeBtn.onclick = closeLogin;
  if (emailField) emailField.onkeydown = function(e){ if (e.key === "Enter") forgotPasswordWithEmail(); };
}

function renderUpdatePasswordScreen(){
  return '<h2 class="auth-title" style="margin-bottom:8px;">Set new password</h2>' +
    '<p class="auth-sub">Choose a new password for your account.</p>' +
    (authSuccess ? '<div class="auth-msg auth-success">' + esc(authSuccess) + '</div>' : '') +
    (authError   ? '<div class="auth-msg auth-error">'   + esc(authError)   + '</div>' : '') +
    '<div class="auth-pw-wrap">' +
      '<input type="password" id="recovery-password" class="auth-input" placeholder="New password (6+ chars)" autocomplete="new-password">' +
      '<button type="button" class="auth-pw-toggle" id="recovery-pw-toggle" tabindex="-1">Show</button>' +
    '</div>' +
    '<button class="btn btn-primary" data-action="auth-update-password" style="width:100%;margin-top:4px;" ' + (authLoading ? 'disabled' : '') + '>' +
      (authLoading ? 'Updating…' : 'Update password') +
    '</button>';
}

function wireUpdatePasswordForm(){
  const toggle = document.getElementById("recovery-pw-toggle");
  const field  = document.getElementById("recovery-password");
  if (toggle && field){
    toggle.onclick = function(){
      const showing = field.type === "text";
      field.type = showing ? "password" : "text";
      this.textContent = showing ? "Show" : "Hide";
    };
  }
  if (field) field.onkeydown = function(e){ if (e.key === "Enter") updatePassword(); };
}

// Wires only what data-action can't handle: close button, Enter key, password reveal.
function wireAuthForm(isSignUp){
  const closeBtn  = document.getElementById("auth-close-btn");
  const pwField   = document.getElementById("auth-password");
  const pwToggle  = document.getElementById("auth-pw-toggle");
  if (closeBtn) closeBtn.onclick = closeLogin;
  if (pwField)  pwField.onkeydown = function(e){
    if (e.key === "Enter") isSignUp ? signUpWithEmail() : signInWithEmail();
  };
  if (pwToggle) pwToggle.onclick = function(){
    if (!pwField) return;
    const showing = pwField.type === "text";
    pwField.type = showing ? "password" : "text";
    this.textContent = showing ? "Show" : "Hide";
  };
}

async function signInWithGoogle(){
  authError = null; authLoading = true; refreshAuth();
  const { error } = await sbClient.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin }
  });
  authLoading = false;
  if (error){ authError = authMsg(error); refreshAuth(); }
}

function wireAuthChoice(){
  const closeBtn = document.getElementById("auth-close-btn");
  if (closeBtn) closeBtn.onclick = closeLogin;
}

function renderAuthModal(){
  const box = document.getElementById("auth-modal-box");
  if (!box) return;
  if (!sbClient){
    box.innerHTML = '<button class="auth-close" id="auth-close-btn">&#x2715;</button>' +
      '<p style="color:var(--muted);font-size:0.9rem;margin-top:8px;">Authentication is not configured on this server.</p>';
    wireAuthChoice();
    return;
  }
  if (authView === "choice"){
    box.innerHTML = authChoiceHTML(true);
    wireAuthChoice();
  } else if (authView === "forgot"){
    box.innerHTML = authForgotHTML(true);
    wireAuthForgot();
  } else {
    const isSignUp = authMode === "signup";
    box.innerHTML = authFormHTML(isSignUp, true);
    wireAuthForm(isSignUp);
  }
}

function renderAuthScreen(){
  const isSignUp = authMode === "signup";
  let formHTML;
  if (!sbClient){
    formHTML = '<p style="color:var(--muted);">Auth not configured — check server env vars.</p>';
  } else if (authView === "choice"){
    formHTML = authChoiceHTML(false);
  } else if (authView === "forgot"){
    formHTML = authForgotHTML(false);
  } else {
    formHTML = authFormHTML(isSignUp, false);
  }
  return '<h1 class="title">Draft &amp; Stamp</h1>' +
    '<p class="subtitle">Turn a rough idea into a precise prompt another AI can actually use.</p>' +
    '<p class="meta-caption" style="margin-bottom:30px;">Sign in to get started — free during beta.</p>' +
    formHTML;
}

function renderAll(){
  renderTopbar();
  const app = document.getElementById("app");
  let body = "";

  if (!appInitialized){
    body = renderLoading("Loading…");
    app.innerHTML = body;
    return;
  }

  if (state.screen === "shared" || state.screen === "shared_loading" || state.screen === "shared_error"){
    app.innerHTML = renderSharedResult();
    return;
  }

  if (pendingPasswordRecovery){
    app.innerHTML = renderUpdatePasswordScreen();
    wireUpdatePasswordForm();
    return;
  }

  if (!currentUser){
    body = renderAuthScreen();
    app.innerHTML = body;
    if (authView === "choice") wireAuthChoice();
    else if (authView === "forgot") wireAuthForgot();
    else wireAuthForm(authMode === "signup");
    return;
  }

  switch(state.screen){
    case "start": body = renderStart(); break;
    case "classifying": body = renderLoading("Reading what you wrote…"); break;
    case "classified": body = renderClassified(); break;
    case "gate": body = renderGate(); break;
    case "considerations_loading": body = renderLoading("Checking what an expert in this area would flag…"); break;
    case "considerations": body = renderConsiderations(); break;
    case "loading_question": body = '<p class="loading-line">Thinking about what to ask next… <span id="question-timer" style="color:var(--muted);font-size:0.9em;">' + (questionElapsed > 0 ? questionElapsed + "s…" : "") + '</span><span class="cursor">▌</span></p>'; break;
    case "interview": body = renderInterview(); break;
    case "staging_loading": body = renderLoading("Planning how to break this into stages…"); break;
    case "staged": body = renderStaged(); break;
    case "generating_loading": body = '<p class="loading-line">Writing your prompt… <span id="generate-timer" style="color:var(--muted);font-size:0.9em;">' + (generateElapsed > 0 ? generateElapsed + "s…" : "") + '</span><span class="cursor">▌</span></p>'; break;
    case "result": body = renderResult(); break;
    case "review": body = renderReview(); break;
    case "history": body = renderHistory(); break;
    default: body = renderStart();
  }
  const noStartOver = new Set(["start","gate","result","history","shared","shared_loading","shared_error"]);
  if (!noStartOver.has(state.screen)){
    body += '<div style="text-align:center;padding-top:22px;margin-top:4px;border-top:1px solid var(--paper-line);"><button data-action="start-over" style="background:none;border:none;color:var(--muted);font-size:0.78rem;cursor:pointer;font-family:inherit;text-decoration:underline;padding:4px;">↩ Start over</button></div>';
  }
  const offlineBanner = !navigator.onLine
    ? '<div class="offline-banner">&#9888;&nbsp; No internet connection detected — check your Wi-Fi or mobile data.</div>'
    : '';
  morphdom(app, '<div id="app" class="paper-card">' + renderProgress() + offlineBanner + body + renderErrorBanner() + '</div>');
}

/* =====================================================================
   TYPEWRITER (result screen only — uses direct DOM writes so it isn't
   interrupted by the lightweight re-renders copy/feedback trigger)
   ===================================================================== */
function startTypewriter(){
  clearInterval(state._typeInterval);
  typewriterDone = false;
  const prompts = (state.finalResult && state.finalResult.prompts) || [];
  const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion){
    prompts.forEach((p,i) => { const el = document.getElementById("prompt-text-" + i); if (el) el.textContent = p.content; });
    typewriterDone = true;
    return;
  }
  let boxIndex = 0;
  function typeNextBox(){
    if (boxIndex >= prompts.length){
      typewriterDone = true;
      // Enable copy buttons now that all text is rendered
      document.querySelectorAll(".prompt-copy-btn[data-action='copy-prompt']").forEach(btn => { btn.disabled = false; btn.style.opacity = ""; });
      const hint = document.querySelector("[data-action='complete-typewriter']");
      if (hint) hint.remove();
      return;
    }
    const el = document.getElementById("prompt-text-" + boxIndex);
    const full = prompts[boxIndex].content;
    if (!el || full.length === 0){ boxIndex++; typeNextBox(); return; }
    el.textContent = "";
    let i = 0;
    const chunk = Math.max(1, Math.floor(full.length/250));
    state._typeInterval = setInterval(() => {
      i += chunk;
      el.textContent = full.slice(0, i);
      if (i >= full.length){
        clearInterval(state._typeInterval);
        boxIndex++;
        typeNextBox();
      }
    }, 12);
  }
  typeNextBox();
}

function flashCopied(btn){
  if (!btn) return;
  const original = btn.dataset.originalLabel || btn.textContent;
  btn.dataset.originalLabel = original;
  btn.textContent = "Copied";
  btn.disabled = true;
  setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1400);
}

function flashCopyFailed(btn){
  if (!btn) return;
  const original = btn.dataset.originalLabel || btn.textContent;
  btn.dataset.originalLabel = original;
  btn.textContent = "Couldn't copy — select manually";
  setTimeout(() => { btn.textContent = original; }, 2400);
}

// navigator.clipboard can silently fail or be unavailable depending on context
// (sandboxed iframe, non-secure origin, browser permissions), so this falls
// back to the older execCommand approach rather than just doing nothing.
function copyTextToClipboard(text){
  if (navigator.clipboard && navigator.clipboard.writeText){
    return navigator.clipboard.writeText(text).catch(() => legacyCopy(text));
  }
  return legacyCopy(text);
}

function legacyCopy(text){
  return new Promise((resolve, reject) => {
    try{
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-9999px";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      if (ok) resolve(); else reject(new Error("execCommand copy failed"));
    } catch(e){ reject(e); }
  });
}

function copyPrompt(index){
  const p = state.finalResult && state.finalResult.prompts[index];
  if (!p) return;
  const btn = document.querySelector('.prompt-copy-btn[data-value="' + index + '"]');
  copyTextToClipboard(p.content).then(() => flashCopied(btn)).catch(() => flashCopyFailed(btn));
}

function copyAllPrompts(){
  if (!state.finalResult) return;
  const joined = state.finalResult.prompts.map(p => "### " + p.label + "\n\n" + p.content).join("\n\n---\n\n");
  const btn = document.getElementById("copy-all-btn");
  copyTextToClipboard(joined).then(() => flashCopied(btn)).catch(() => flashCopyFailed(btn));
}

function setPromptRating(v){
  state.promptRating = v;
  document.querySelectorAll(".fb-pill[data-group='prompt']").forEach(p => {
    p.classList.toggle("sel", p.dataset.v === String(v));
  });
  saveFeedbackToDb({ rating: v });
}

function setResultsRating(v){
  state.resultsRating = v;
  document.querySelectorAll(".fb-pill[data-group='results']").forEach(p => {
    p.classList.toggle("sel", p.dataset.v === String(v));
  });
  saveFeedbackToDb({ results_rating: v });
}

async function submitFeedback(){
  const ta = document.getElementById("fb-comment");
  const comment = ta ? ta.value.trim() : state.feedbackComment;
  state.feedbackComment = comment;
  await saveFeedbackToDb({ rating: state.promptRating, results_rating: state.resultsRating, comment });
  state.feedbackSent = true;
  renderAll();
}

/* =====================================================================
   EVENT DELEGATION
   ===================================================================== */
// Bound to #app itself (which persists across renders), not to any specific
