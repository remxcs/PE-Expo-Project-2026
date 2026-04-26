const { BedrockRuntimeClient, ConverseCommand } = require("@aws-sdk/client-bedrock-runtime");
const { loadSwimLibrary } = require("./swim-library");

const bedrockClient = new BedrockRuntimeClient({});

const SWIMMING_QUESTION_OPTIONS = {
  "current-level": {
    A: "Beginner",
    B: "Casual",
    C: "Regular"
  },
  "goal-level": {
    A: "Casual",
    B: "Regular",
    C: "Club Level"
  },
  "improvement-area": {
    A: "No specific area",
    B: "Stamina",
    C: "Technique",
    D: "Lactate"
  }
};

const RECOMMENDATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "summary", "focus", "intensity", "rationale", "variationNote", "setIds", "coachNotes"],
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    focus: { type: "string" },
    intensity: { type: "string" },
    rationale: { type: "string" },
    variationNote: { type: "string" },
    setIds: {
      type: "array",
      minItems: 2,
      maxItems: 5,
      items: { type: "string" }
    },
    coachNotes: {
      type: "array",
      minItems: 2,
      maxItems: 4,
      items: { type: "string" }
    }
  }
};
const MAX_RETRY_FEEDBACK_LENGTH = 500;
const MAX_TEXT_FIELD_LENGTH = 280;
const MAX_NOTE_LENGTH = 200;
const MAX_PRIOR_SESSION_COUNT = 5;
const MAX_BEDROCK_ATTEMPTS = 2;
const MAX_SHORTLIST_SIZE = 12;

const SWIM_SET_ROLE_TYPES = {
  warmup: ["preset"],
  main: ["main", "kick", "pull"],
  cooldown: ["cooldown"]
};

function sanitizePromptText(value, maxLength = MAX_TEXT_FIELD_LENGTH) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().slice(0, maxLength);
}

function normalizeAnswerLabel(questionId, answerId) {
  return SWIMMING_QUESTION_OPTIONS[questionId]?.[answerId] ?? answerId;
}

function summarizeAnswers(swimmingAnswers) {
  return {
    currentLevel: normalizeAnswerLabel("current-level", swimmingAnswers?.["current-level"]),
    goalLevel: normalizeAnswerLabel("goal-level", swimmingAnswers?.["goal-level"]),
    improvementArea: normalizeAnswerLabel("improvement-area", swimmingAnswers?.["improvement-area"])
  };
}

function getTargetDistanceRange(answerSummary) {
  if (answerSummary.currentLevel === "Beginner") {
    return { min: 400, max: 1200 };
  }

  if (answerSummary.currentLevel === "Casual") {
    return { min: 800, max: 1800 };
  }

  return { min: 1200, max: 2600 };
}

function getTargetFocus(answerSummary) {
  if (answerSummary.improvementArea === "No specific area") {
    return "general";
  }

  return answerSummary.improvementArea.toLowerCase();
}

function getTargetIntensity(answerSummary) {
  if (answerSummary.currentLevel === "Beginner") {
    return ["easy", "moderate", null];
  }

  if (answerSummary.goalLevel === "Club Level") {
    return ["moderate", "hard", null];
  }

  return ["moderate", "easy", null];
}

function scoreSet(swimSet, answerSummary, recentSetIds) {
  const targetFocus = getTargetFocus(answerSummary);
  const { min, max } = getTargetDistanceRange(answerSummary);
  const preferredIntensities = getTargetIntensity(answerSummary);
  const totalDistance = swimSet.total_distance ?? 0;
  let score = 0;

  if (swimSet.training_focus?.includes(targetFocus)) {
    score += 5;
  }

  if (targetFocus !== "general" && (swimSet.training_focus_certainty?.[targetFocus] ?? 0) >= 0.6) {
    score += 3;
  }

  if (swimSet.training_focus?.includes("general")) {
    score += 1;
  }

  if (totalDistance >= min && totalDistance <= max) {
    score += 4;
  } else if (totalDistance >= min * 0.75 && totalDistance <= max * 1.2) {
    score += 2;
  }

  if (preferredIntensities.includes(swimSet.intensity ?? null)) {
    score += 2;
  }

  if (swimSet.type === "cooldown") {
    score += 1;
  }

  if (swimSet.type === "kick" && targetFocus === "technique") {
    score += 2;
  }

  if (recentSetIds.has(swimSet.id)) {
    score -= 4;
  }

  return score;
}

function getSessionSetRole(swimSet) {
  if (SWIM_SET_ROLE_TYPES.warmup.includes(swimSet.type)) {
    return "warmup";
  }

  if (SWIM_SET_ROLE_TYPES.cooldown.includes(swimSet.type)) {
    return "cooldown";
  }

  if (SWIM_SET_ROLE_TYPES.main.includes(swimSet.type)) {
    return "main";
  }

  return "main";
}

function mergeRequiredRoleSets(scoredSets) {
  const selectedSets = [];
  const selectedIds = new Set();

  for (const role of ["warmup", "main", "cooldown"]) {
    const requiredSet = scoredSets.find((swimSet) => getSessionSetRole(swimSet) === role);

    if (requiredSet && !selectedIds.has(requiredSet.id)) {
      selectedSets.push(requiredSet);
      selectedIds.add(requiredSet.id);
    }
  }

  for (const swimSet of scoredSets) {
    if (selectedSets.length >= MAX_SHORTLIST_SIZE) {
      break;
    }

    if (selectedIds.has(swimSet.id)) {
      continue;
    }

    selectedSets.push(swimSet);
    selectedIds.add(swimSet.id);
  }

  return selectedSets;
}

function shortlistSwimSets(swimmingAnswers, sessions) {
  const answerSummary = summarizeAnswers(swimmingAnswers);
  const recentSetIds = new Set(
    sessions
      .slice(0, 3)
      .flatMap((session) => session.recommendation?.sets?.map((set) => set.id) ?? [])
  );

  const scoredSets = loadSwimLibrary()
    .map((swimSet) => ({
      ...swimSet,
      score: scoreSet(swimSet, answerSummary, recentSetIds)
    }))
    .sort((left, right) => right.score - left.score);

  return mergeRequiredRoleSets(scoredSets)
    .slice(0, MAX_SHORTLIST_SIZE)
    .map(({ score, ...swimSet }) => swimSet);
}

function summarizeRecentSessions(sessions) {
  return sessions.slice(0, MAX_PRIOR_SESSION_COUNT).map((session) => ({
    sessionId: session.sessionId,
    acceptedAt: session.acceptedAt,
    status: session.status,
    title: session.recommendation?.title ?? "Untitled session",
    focus: session.recommendation?.focus ?? "general",
    totalDistance: session.recommendation?.totalDistance ?? null,
    variationNote: session.recommendation?.variationNote ?? "",
    feedbackText: sanitizePromptText(session.feedbackText, MAX_RETRY_FEEDBACK_LENGTH),
    setIds: session.recommendation?.sets?.map((set) => set.id).filter(Boolean) ?? [],
    questionnaireSnapshot: session.questionnaireSnapshot ? summarizeAnswers(session.questionnaireSnapshot) : null
  }));
}

function deriveFeedbackSignals(priorSessions) {
  const positiveSignals = [];
  const negativeSignals = [];
  const avoidSetIds = new Set();

  for (const session of priorSessions) {
    const signal = {
      title: sanitizePromptText(session.title),
      focus: sanitizePromptText(session.focus, 80),
      totalDistance: session.totalDistance ?? null,
      feedbackText: sanitizePromptText(session.feedbackText, MAX_RETRY_FEEDBACK_LENGTH),
      setIds: Array.isArray(session.setIds) ? session.setIds.filter(Boolean) : []
    };

    if (session.status === "completed" && signal.feedbackText) {
      positiveSignals.push(signal);
    }

    if (session.status === "skipped") {
      negativeSignals.push(signal);
      for (const setId of signal.setIds) {
        avoidSetIds.add(setId);
      }
    }
  }

  return {
    positiveSignals,
    negativeSignals,
    avoidSetIds: [...avoidSetIds]
  };
}

function buildRecommendationRequest({ answerSummary, candidates, priorSessions, retryFeedback, previousValidationError, previousInvalidResponse }) {
  return {
    responseSchema: RECOMMENDATION_SCHEMA,
    swimmerProfile: answerSummary,
    retryFeedback: sanitizePromptText(retryFeedback, MAX_RETRY_FEEDBACK_LENGTH),
    priorSessions,
    feedbackSignals: deriveFeedbackSignals(priorSessions),
    candidateSets: candidates.map((candidate) => ({
      id: candidate.id,
      text: candidate.text,
      type: candidate.type,
      totalDistance: candidate.total_distance,
      intensity: candidate.intensity,
      trainingFocus: candidate.training_focus,
      equipment: candidate.equipment,
      strokes: candidate.strokes,
      rest: candidate.rest
    })),
    ...(previousValidationError ? { previousValidationError: sanitizePromptText(previousValidationError, 400) } : {}),
    ...(previousInvalidResponse ? { previousInvalidResponse: sanitizePromptText(previousInvalidResponse, 500) } : {})
  };
}

function parseRecommendationResponse(responseText) {
  const trimmedResponse = responseText.trim();
  const withoutCodeFence = trimmedResponse
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  return JSON.parse(withoutCodeFence);
}

async function invokeBedrockRecommendation({ modelId, answerSummary, candidates, priorSessions, retryFeedback, previousValidationError, previousInvalidResponse }) {
  const systemPrompt = [
    "You are an expert youth swimming coach.",
    "Build one suitable swim session from the candidate library entries provided.",
    "Use the swimmer profile as the primary constraint for level, goal, and improvement area.",
    "Use retry feedback as the strongest immediate instruction for the next suggestion.",
    "Use prior completed and skipped sessions plus their feedback to improve future suggestions.",
    "Avoid repeating candidate set IDs that appear in negative or skipped feedback unless the retry feedback explicitly asks for them.",
    "Every swim session must include a warmup, at least one main-work block, and a cooldown.",
    "Treat shortlist entries with type 'preset' as warmup, shortlist entries with type 'cooldown' as cooldown, and entries with type 'main', 'kick', or 'pull' as main-work blocks.",
    "Choose 2 to 5 candidate set IDs only from the shortlist.",
    "Keep the recommendation safe, progressive, varied from recent sessions, and aligned to the swimmer's level and goals.",
    "Do not invent new set IDs, distances, or drills outside the shortlist.",
    "Return valid JSON only that matches the required schema and do not wrap it in markdown."
  ].join(" ");

  const userPrompt = JSON.stringify(buildRecommendationRequest({
    answerSummary,
    candidates,
    priorSessions,
    retryFeedback,
    previousValidationError,
    previousInvalidResponse
  }));

  const response = await bedrockClient.send(new ConverseCommand({
    modelId,
    system: [{ text: systemPrompt }],
    messages: [
      {
        role: "user",
        content: [{ text: userPrompt }]
      }
    ],
    inferenceConfig: {
      maxTokens: 700,
      temperature: 0.3,
      topP: 0.9
    }
  }));

  const responseText = response.output?.message?.content?.map((entry) => entry.text ?? "").join("").trim();

  if (!responseText) {
    throw new Error("Bedrock returned an empty recommendation.");
  }

  return parseRecommendationResponse(responseText);
}

function validateRecommendationPayload(payload, candidateSetMap) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("The recommendation response was not a valid object.");
  }

  for (const key of RECOMMENDATION_SCHEMA.required) {
    if (!(key in payload)) {
      throw new Error(`The recommendation response was missing '${key}'.`);
    }
  }

  const requiredTextFields = ["title", "summary", "focus", "intensity", "rationale", "variationNote"];

  for (const fieldName of requiredTextFields) {
    if (typeof payload[fieldName] !== "string" || !payload[fieldName].trim()) {
      throw new Error(`The recommendation field '${fieldName}' must be a non-empty string.`);
    }
  }

  if (!Array.isArray(payload.setIds) || payload.setIds.length < 2 || payload.setIds.length > 5) {
    throw new Error("The recommendation must include between 2 and 5 set ids.");
  }

  if (!Array.isArray(payload.coachNotes) || payload.coachNotes.length < 2 || payload.coachNotes.length > 4) {
    throw new Error("The recommendation must include between 2 and 4 coach notes.");
  }

  const dedupedSetIds = [...new Set(payload.setIds)];

  if (dedupedSetIds.length !== payload.setIds.length) {
    throw new Error("The recommendation repeated a swim set id.");
  }

  const selectedSets = dedupedSetIds.map((setId) => candidateSetMap.get(setId)).filter(Boolean);

  if (selectedSets.length !== dedupedSetIds.length) {
    throw new Error("The recommendation referenced a swim set outside the shortlist.");
  }

  const selectedRoles = new Set(selectedSets.map((set) => getSessionSetRole(set)));

  if (!selectedRoles.has("warmup")) {
    throw new Error("The recommendation must include a warmup set.");
  }

  if (!selectedRoles.has("main")) {
    throw new Error("The recommendation must include a main-work set.");
  }

  if (!selectedRoles.has("cooldown")) {
    throw new Error("The recommendation must include a cooldown set.");
  }

  return {
    title: payload.title.trim().slice(0, MAX_TEXT_FIELD_LENGTH),
    summary: payload.summary.trim().slice(0, MAX_TEXT_FIELD_LENGTH),
    focus: payload.focus.trim().slice(0, 80),
    intensity: payload.intensity.trim().slice(0, 80),
    rationale: payload.rationale.trim().slice(0, MAX_TEXT_FIELD_LENGTH),
    variationNote: payload.variationNote.trim().slice(0, MAX_TEXT_FIELD_LENGTH),
    coachNotes: payload.coachNotes.map((note) => {
      if (typeof note !== "string" || !note.trim()) {
        throw new Error("Each coach note must be a non-empty string.");
      }

      return note.trim().slice(0, MAX_NOTE_LENGTH);
    }),
    selectedSets
  };
}

async function buildSwimmingRecommendation({ modelId, swimmingAnswers, sessions, retryFeedback }) {
  const answerSummary = summarizeAnswers(swimmingAnswers);
  const shortlistedSets = shortlistSwimSets(swimmingAnswers, sessions);
  const recentSessions = summarizeRecentSessions(sessions);
  const selectedSetMap = new Map(shortlistedSets.map((set) => [set.id, set]));
  let previousError = "";
  let previousInvalidResponse = "";
  let validatedRecommendation = null;

  for (let attempt = 0; attempt < MAX_BEDROCK_ATTEMPTS; attempt += 1) {
    try {
      const llmRecommendation = await invokeBedrockRecommendation({
        modelId,
        answerSummary,
        candidates: shortlistedSets,
        priorSessions: recentSessions,
        retryFeedback,
        previousValidationError: previousError,
        previousInvalidResponse
      });
      validatedRecommendation = validateRecommendationPayload(llmRecommendation, selectedSetMap);
      break;
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }

      previousError = error.message;

      if (attempt === MAX_BEDROCK_ATTEMPTS - 1) {
        throw error;
      }

      previousInvalidResponse = error.message;
    }
  }

  if (!validatedRecommendation) {
    throw new Error("Unable to build a valid swimming recommendation.");
  }

  const selectedSets = validatedRecommendation.selectedSets;

  return {
    title: validatedRecommendation.title,
    summary: validatedRecommendation.summary,
    focus: validatedRecommendation.focus,
    intensity: validatedRecommendation.intensity,
    rationale: validatedRecommendation.rationale,
    variationNote: validatedRecommendation.variationNote,
    coachNotes: validatedRecommendation.coachNotes,
    totalDistance: selectedSets.reduce((total, set) => total + (set.total_distance ?? 0), 0),
    sets: selectedSets,
    generatedAt: new Date().toISOString()
  };
}

module.exports = {
  buildRecommendationRequest,
  buildSwimmingRecommendation,
  deriveFeedbackSignals,
  getSessionSetRole,
  mergeRequiredRoleSets,
  parseRecommendationResponse,
  shortlistSwimSets,
  summarizeRecentSessions,
  summarizeAnswers
};
