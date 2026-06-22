/* =====================================================================
   CONFIG — constants, seeds, stage hints, response schemas
   ===================================================================== */
/* =====================================================================
   DATA — lightweight inspiration only, not a script.
   TOPIC_SEEDS: per-category things that are *often* worth probing — the
   model treats these as a starting point, not a checklist to recite. It
   writes its own question text, its own options, and is free to ask
   about something not listed here if the request calls for it.
   STAGE_HINTS: same idea for staging — a rough, informal shape of how a
   category's output commonly breaks into parts, not a rigid menu with
   trigger rules. The model decides what actually applies.
   ===================================================================== */
const TOPIC_SEEDS = {
  writing: [
    "for correspondence (cover letters, formal letters, business emails, client proposals): the sender's full name to sign the letter, plus any contact details to include in the signature — phone number, LinkedIn URL, email address",
    "for cover letters and job applications specifically: real certifications, courses, or credentials the applicant holds; specific named companies or projects they have worked on; concrete achievements or results from those experiences; and what specifically draws them to this company or role — without these the output is a generic template",
    "for marketing copy or ads: the single most important message or claim; what action the reader should take; and where this will appear (website hero, email subject line, paid ad, product packaging, social caption)",
    "for social media: which platform — LinkedIn, Instagram, X/Twitter, TikTok — each has a very different optimal length, tone, and structure",
    "the real names of any people, companies, or titles involved — or whether to use placeholders",
    "who will read it and what relationship the writer has with them — close colleague, hiring manager, a company they've never contacted, a recruiter, etc.",
    "the feel or voice — formal and polished, warm and conversational, direct and brief, friendly but professional, or something in between",
    "how long it should be",
    "whether it should end with a specific call to action or next step",
    "facts, numbers, or specific details that must be included",
    "existing writing (yours or someone else's) to match the style of",
    "anything it should avoid saying, or any tone it should not take",
  ],
  financial_model: [
    "what the model is actually for — internal budget, investor pitch, equity valuation, M&A diligence, lender presentation, or personal planning",
    "whether this is for a specific real company — if so, whether it is publicly listed, on which exchange, and the ticker symbol",
    "the most recent fiscal year with complete, published financial data to anchor the model as the base year",
    "how far ahead the forecast should look",
    "the primary revenue drivers — and whether revenues are earned in local currency, foreign currency, or both (export/import exposure)",
    "key cost drivers that move with external prices — raw materials, commodities (cotton, oil, steel, wheat), energy, freight",
    "whether to use the company's own real published numbers or illustrative placeholder figures",
    "big-picture summary vs. detailed line-by-line with explicit forecasting methodology per line",
    "who will be reading and judging this — internal planning only, or external investors, a bank, a regulator, or an investment committee",
    "what valuation approaches to include — DCF only, comparable company multiples (EV/EBITDA, P/E, P/B), dividend discount, or a combination",
    "whether a current market price comparison is needed (for listed equity: intrinsic value only means something relative to the share price)",
    "growth assumptions, risk factors, and whether best/base/worst-case scenario analysis is required",
    "capital structure details — significant existing debt, recent equity raises, convertible instruments, or planned capex",
    "the regulatory and accounting framework — which country, which reporting standard (IFRS, US GAAP, local GAAP), listed vs private requirements",
    "whether sensitivity tables or scenario toggles (e.g. bear/base/bull) are needed, and if so which variables to stress",
  ],
  code: [
    "the programming language, framework, or tool — if they already have one in mind",
    "a concrete example: what goes in, and exactly what should come out",
    "whether this runs once or is relied on repeatedly — affects how robust it needs to be",
    "what AI tool or environment will run this — ChatGPT code interpreter, Claude Artifacts, a local IDE, a production server — different environments have different available libraries",
    "messy edge cases it should handle without breaking — empty inputs, large volumes, unexpected formats",
    "anything it needs to connect to, read from, or write to — APIs, files, databases, other services",
    "what should happen when something goes wrong — error messages, silent fallback, retry, or crash loudly",
    "scale and performance requirements — runs on one file vs millions of rows, latency-sensitive or batch",
  ],
  image: [
    "which image generation tool — Midjourney, DALL-E, Stable Diffusion, Flux, Ideogram, Adobe Firefly — each has different syntax, strengths, and prompt conventions",
    "the main subject and what's happening in the scene",
    "art style or medium — photorealistic, oil painting, flat illustration, anime, 3D render, watercolor, etc.",
    "mood, lighting, and color palette",
    "aspect ratio and where the image will be used — social post, website banner, print, wallpaper",
    "specific things to avoid in the image — elements, styles, or visual treatments to exclude",
    "a reference image, artist, or specific style to lean toward",
    "whether this is for commercial use — some tools have licensing restrictions that affect how the prompt should be framed",
  ],
  research: [
    "output format — a bulleted summary, a narrative essay, a comparison table, an executive brief, or raw notes to work from",
    "how deep vs. broad — one topic in depth, or a broad landscape scan",
    "what they already know, so the AI doesn't over-explain basics they're past",
    "what this is actually for — making a decision, learning for the first time, writing something, preparing for a meeting",
    "recency requirements — must draw on sources from the last X years, or are foundational/timeless principles fine?",
    "whether specific sources, methodologies, or types of evidence matter",
    "how to handle uncertainty or conflicting information — flag it explicitly, present the dominant view, or lay out both sides",
    "any sub-questions that absolutely must be answered",
  ],
  presentation: [
    "who's in the room and the occasion — internal team, external investors, a client, a conference audience",
    "roughly how many slides",
    "the single most important thing the audience should walk away remembering",
    "how dense each slide should be — one idea per slide with lots of white space, or detailed reference slides",
    "data, charts, or visuals that need to be included",
    "whether it'll be presented live (with speaker narration) or sent to be read on its own",
    "whether speaker notes should be written out in full or just bullet points",
    "software target — PowerPoint, Google Slides, or Keynote — affects formatting language in the prompt",
    "any brand, color, or style guidelines to follow",
  ],
  video: [
    "is this a prompt for an AI video generation tool (Sora, Runway, Kling, Pika, Luma, Veo) or a script for a human to record (YouTube, TikTok, Reels, podcast, explainer, ad)?",
    "for AI video generation: the main subject and what action or motion is happening; camera movement (static, pan left/right, tracking shot, zoom in/out, dolly, aerial); duration in seconds; lighting and time of day; visual style (cinematic, lo-fi, animation, documentary, hyper-real, stylized); anything that should NOT appear",
    "for video scripts: the hook — what should stop someone from scrolling in the first 3 seconds; the core message or story arc; the call to action at the end; approximate duration or word count",
    "for YouTube or long-form video: whether to include chapter markers, B-roll direction notes, or just the spoken script",
    "for ads or short-form: the platform (TikTok, Instagram Reels, YouTube Shorts) — each has different pacing and format norms",
    "the tone and energy — fast-paced and punchy, slow and cinematic, educational and calm, hype and high-energy",
    "whether voiceover, on-screen text, or music direction should be included in the script",
  ],
  agent_prompt: [
    "what is this AI agent supposed to do — what tasks will it handle, and what should it refuse or escalate?",
    "who will be talking to it — customers, internal team members, students, general public, or a specific professional audience?",
    "what persona, name, or voice should it have — and does it need to maintain a specific brand tone or avoid breaking character?",
    "what are the most important hard constraints — things it must NEVER do, say, or reveal under any circumstances?",
    "what format should its responses take — bullet points, conversational prose, structured with headers, concise answers only, always ask a follow-up question?",
    "does it need to follow a specific workflow — like always qualifying the user first, routing to different responses based on answers, or following a script for certain topics?",
    "what platform or product will this run in — ChatGPT custom GPT, Claude Project, API system prompt, customer service tool, website widget? Platform determines syntax and feature constraints",
    "what knowledge or context should the agent always have access to — company info, product details, policies, FAQs?",
    "should it know when to hand off to a human, and if so how should it handle that transition?",
    "examples of ideal responses, or descriptions of bad behavior the prompt needs to prevent",
  ],
  legal: [
    "which country and specific legal jurisdiction governs this document — state/province matters for contracts in federal systems",
    "who are the parties — individual persons, companies, or both — and what is each party's role in the agreement?",
    "what is the core obligation or exchange being defined — what does each party owe the other?",
    "key clauses that must be included — confidentiality/NDA terms, IP assignment, non-compete or non-solicit, indemnification, limitation of liability, governing law, dispute resolution (arbitration vs. litigation vs. mediation)",
    "duration of the agreement and termination conditions — fixed term, perpetual, terminable at will, or with notice?",
    "is this for internal drafting only (will be reviewed by a lawyer before use) or meant to be the final signed version?",
    "how formal and precise should the language be — standard commercial contract language, plain English for a consumer audience, or simplified for a startup context?",
    "specific risks or protections one party needs — payment protection, IP ownership clarity, confidentiality, exclusivity, warranties",
    "whether standard boilerplate clauses (force majeure, entire agreement, severability, notices) should be included or kept minimal",
  ],
  other: [
    "what success looks like — what would a perfect output do or contain?",
    "who this is actually for — who will use or read the output?",
    "constraints or things to avoid",
    "how much detail is wanted — high-level overview or thorough deep-dive?",
    "any examples of similar outputs that show the right direction",
  ],
};

const STAGE_HINTS = {
  financial_model: "SCOPE FIRST — only plan stages for what was explicitly requested. If the user asked for comparable valuation only: one stage, comps analysis, done. If the user asked for DCF only: one to two stages. If the user asked for a full model (forecast + DCF + comps): follow the sequencing below. Never add a valuation stage to a forecast request, or a DCF stage to a comps-only request, just because it seems standard practice. The user controls scope.\n\nFor FULL equity valuation models (explicitly including forecast + DCF + comps): Stage 1 = data foundation — base year actuals, sourcing approach, and all key assumptions (revenue drivers, FX rates, commodity prices, cost structure, WACC inputs) before any forecasting begins. Stage 2 = full financial statement build-out — forecasted income statement, balance sheet, and cash flow statement with explicit methodology per line item. Stage 3 = valuation — DCF (FCFF, WACC, terminal value) AND comparable company multiples; intrinsic value vs current market price for listed equity. Stage 4 = scenario analysis and investor-ready output — best/base/worst cases, sensitivity tables, executive summary. CRITICAL: never combine DCF calculation and scenario analysis in the same stage. For comps-only, forecast-only, or budget-only tasks: 1 stage is almost always right.",
  writing: "Usually short enough to stay one stage. Only split it if there are genuinely distinct pieces to draft separately — for example a long piece with real sections, or a sequence like a teaser followed by the full piece.",
  code: "Often breaks into: the core logic; then edge-case handling and validation; then polish, tests, or docs, but only if it's something that'll be reused rather than run once. Collapse to one stage for anything simple.",
  presentation: "Often breaks into: overall structure/outline; then slide-by-slide content; then speaker notes or visual polish, but only if those were actually asked for.",
  image: "Almost always a single stage — splitting an image prompt rarely helps.",
  research: "Usually a single stage, unless the request genuinely spans multiple distinct sub-questions worth answering one at a time.",
  video: "For AI video generation prompts: always one stage — a single well-crafted scene prompt is the deliverable. For video scripts: short-form (under 3 minutes, TikTok, Reels, ads) is always one stage. Long-form (YouTube, podcast, explainer) may split into hook + body sections + CTA, but only if the request explicitly asks for a full script with structure — otherwise one stage.",
  agent_prompt: "Almost always one stage — a system prompt is a single coherent document. Only split if the agent needs a primary instruction block plus a separate reference section (e.g. a product FAQ or policy doc the agent should cite), and even then only if the user explicitly asked for both.",
  legal: "Simple agreements (NDAs, basic service agreements, simple letters of intent): one stage. Complex documents (full employment agreement, terms of service, privacy policy) may split into: core obligations and definitions; then boilerplate provisions (IP, liability, termination, governing law); then execution/signature block — but only if the request explicitly asks for a complete final document, not a draft for counsel review.",
  other: "No fixed shape for this category — decide purely from what's genuinely separable in this specific request."
};

// Ordered model pools — server tries in priority order, falls back down the list
const FAST_MODELS   = ["gemini-3.1-flash-lite", "gemma-4-26b-a4b-it", "gemma-4-31b-it"];
const STRONG_MODELS = ["gemini-2.5-flash", "gemini-3.5-flash"];
// Aliases used in a few legacy logUsage call sites before modelUsed is returned
const FAST_MODEL   = FAST_MODELS[0];
const STRONG_MODEL = STRONG_MODELS[0];
const APP_VERSION  = "v2.9.3";

// Usage limits are enforced server-side when unrestricted_mode is off.

/* =====================================================================
   SYSTEM PROMPTS — adapted from system_prompts.md, with an explicit
   JSON-only output contract added for steps 1–3 (no schema-enforced
   tool call available here, so the contract has to live in the prompt).
   ===================================================================== */

const CATEGORY_ENUM = ["writing","code","image","research","financial_model","presentation","video","agent_prompt","legal","other"];

const CLASSIFY_SCHEMA = {
  type:"object",
  properties:{
    primary_category:{ type:"string", enum:CATEGORY_ENUM },
    secondary_category:{ type:"string", enum:CATEGORY_ENUM, nullable:true },
    complexity:{ type:"string", enum:["small","big"] },
    stakes:{ type:"string", enum:["routine","professional","sensitive"] },
    output_format:{ type:"string", enum:["excel_file","presentation_file","code_file","written_text","image","video_prompt","system_prompt","legal_document","auto"], nullable:true },
    confidence:{ type:"number" },
    reasoning:{ type:"string" },
    contradictions:{ type:"array", items:{ type:"string" }, nullable:true }
  },
  required:["primary_category","complexity","stakes","output_format","confidence","reasoning"]
};

const CONSIDERATIONS_SCHEMA = {
  type:"object",
  properties:{
    required_topics:{
      type:"array",
      items:{
        type:"object",
        properties:{
          id:{ type:"string" },
          label:{ type:"string" },
          reason:{ type:"string" }
        },
        required:["id","label","reason"]
      }
    }
  },
  required:["required_topics"]
};

const SELECT_QUESTION_SCHEMA = {
  type:"object",
  properties:{
    action:{ type:"string", enum:["ask_question","complete"] },
    next_question:{
      type:"object",
      nullable:true,
      properties:{
        id:{ type:"string" },
        text:{ type:"string" },
        input_type:{ type:"string", enum:["single_select","multi_select","slider","free_text"] },
        options:{
          type:"array",
          nullable:true,
          items:{
            type:"object",
            properties:{
              label:{ type:"string" },
              example:{ type:"string", nullable:true }
            },
            required:["label"]
          }
        },
        hint:{ type:"string", nullable:true },
        covers_topic_id:{ type:"string", nullable:true },
        priority:{ type:"string", enum:["critical","enrichment"], nullable:true },
        prefill:{ type:"string", nullable:true }
      },
      required:["id","text","input_type"]
    }
  },
  required:["action"]
};

const STAGE_PLANNER_SCHEMA = {
  type:"object",
  properties:{
    stages:{
      type:"array",
      items:{
        type:"object",
        properties:{
          id:{ type:"string" },
          title:{ type:"string" },
          purpose:{ type:"string" }
        },
        required:["id","title","purpose"]
      }
    },
    collapsed_to_single:{ type:"boolean" }
  },
  required:["stages","collapsed_to_single"]
};

const GENERATE_SCHEMA = {
  type:"object",
  properties:{
    assumptions:{ type:"array", items:{ type:"string" } },
    elevated_stakes_notes:{ type:"array", items:{ type:"string" } },
    prompts:{
      type:"array",
      items:{
        type:"object",
        properties:{
          label:{ type:"string" },
          purpose:{ type:"string", nullable:true },
          usage_notes:{ type:"string", nullable:true },
          content:{ type:"string" }
        },
        required:["label","content"]
      }
    }
  },
  required:["assumptions","elevated_stakes_notes","prompts"]
};
