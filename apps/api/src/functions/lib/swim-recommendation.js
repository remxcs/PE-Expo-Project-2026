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

function shortlistSwimSets(swimmingAnswers, sessions) {
  const answerSummary = summarizeAnswers(swimmingAnswers);
  const recentSetIds = new Set(
    sessions
      .slice(0, 3)
      .flatMap((session) => session.recommendation?.sets?.map((set) => set.id) ?? [])
  );

  return loadSwimLibrary()
    .map((swimSet) => ({
      ...swimSet,
      score: scoreSet(swimSet, answerSummary, recentSetIds)
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 12)
    .map(({ score, ...swimSet }) => swimSet);
}

function summarizeRecentSessions(sessions) {
  return sessions.slice(0, 5).map((session) => ({
    sessionId: session.sessionId,
    acceptedAt: session.acceptedAt,
    status: session.status,
    title: session.recommendation?.title ?? "Untitled session",
    focus: session.recommendation?.focus ?? "general",
    totalDistance: session.recommendation?.totalDistance ?? null,
    variationNote: session.recommendation?.variationNote ?? "",
    feedbackText: session.feedbackText ?? ""
  }));
}

async function invokeBedrockRecommendation({ modelId, answerSummary, candidates, priorSessions, retryFeedback }) {
  const systemPrompt = [
    "You are an expert youth swimming coach.",
    "Build one suitable swim session from the candidate library entries provided.",
    "Choose 2 to 5 candidate set IDs only from the shortlist.",
    "Keep the recommendation safe, progressive, varied from recent sessions, and aligned to the swimmer's level and goals.",
    "Return valid JSON only that matches the required schema and do not wrap it in markdown."
  ].join(" ");

  const userPrompt = JSON.stringify({
    responseSchema: RECOMMENDATION_SCHEMA,
    swimmerProfile: answerSummary,
    retryFeedback: (retryFeedback || "").slice(0, MAX_RETRY_FEEDBACK_LENGTH),
    priorSessions,
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
    }))
  });

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

  return JSON.parse(responseText);
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
  const llmRecommendation = await invokeBedrockRecommendation({
    modelId,
    answerSummary,
    candidates: shortlistedSets,
    priorSessions: recentSessions,
    retryFeedback
  });
  const selectedSetMap = new Map(shortlistedSets.map((set) => [set.id, set]));
  const validatedRecommendation = validateRecommendationPayload(llmRecommendation, selectedSetMap);
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
  buildSwimmingRecommendation,
  summarizeAnswers
};
