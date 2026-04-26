const test = require("node:test");
const assert = require("node:assert/strict");

const { buildStableSwimSetId } = require("./swim-library");
const {
  buildStructuredCandidateSet,
  buildRecommendationRequest,
  deriveFeedbackSignals,
  getSessionSetRole,
  mergeRequiredRoleSets,
  shortlistSwimSets,
  summarizeAnswers,
  summarizeRecentSessions
} = require("./swim-recommendation");

test("buildStableSwimSetId stays stable for the same swim set content", () => {
  const swimSet = {
    text: "8 x 50 free",
    type: "main",
    reps: 8,
    distance: 50,
    distance_unit: "m",
    total_distance: 400,
    rest: "15s",
    strokes: ["Freestyle"],
    equipment: [],
    training_focus: ["stamina"],
    training_focus_certainty: { stamina: 0.8 },
    intensity: "moderate",
    source: "example",
    tags: []
  };

  assert.equal(buildStableSwimSetId(swimSet), buildStableSwimSetId({ ...swimSet }));
});

test("summarizeRecentSessions and feedback signals keep usable coaching context", () => {
  const sessions = [
    {
      sessionId: "planned-1",
      acceptedAt: "2026-04-26T10:00:00.000Z",
      status: "completed",
      feedbackText: "Loved the technique focus and shorter reps",
      questionnaireSnapshot: {
        "current-level": "B",
        "goal-level": "C",
        "improvement-area": "C"
      },
      recommendation: {
        title: "Technique builder",
        focus: "technique",
        totalDistance: 1200,
        variationNote: "More drills",
        sets: [{ id: "swim-set-alpha" }, { id: "swim-set-beta" }]
      }
    },
    {
      sessionId: "planned-2",
      acceptedAt: "2026-04-25T10:00:00.000Z",
      status: "skipped",
      feedbackText: "Too much butterfly and too long",
      questionnaireSnapshot: {
        "current-level": "B",
        "goal-level": "C",
        "improvement-area": "B"
      },
      recommendation: {
        title: "Long fly set",
        focus: "lactate",
        totalDistance: 1800,
        variationNote: "More fly",
        sets: [{ id: "swim-set-gamma" }]
      }
    }
  ];

  const priorSessions = summarizeRecentSessions(sessions);
  const feedbackSignals = deriveFeedbackSignals(priorSessions);

  assert.deepEqual(priorSessions[0].questionnaireSnapshot, summarizeAnswers(sessions[0].questionnaireSnapshot));
  assert.deepEqual(priorSessions[1].setIds, ["swim-set-gamma"]);
  assert.equal(feedbackSignals.positiveSignals.length, 1);
  assert.equal(feedbackSignals.negativeSignals.length, 1);
  assert.deepEqual(feedbackSignals.avoidSetIds, ["swim-set-gamma"]);
});

test("buildRecommendationRequest includes retry feedback and derived feedback signals", () => {
  const request = buildRecommendationRequest({
    answerSummary: {
      currentLevel: "Casual",
      goalLevel: "Club Level",
      improvementArea: "Technique"
    },
    retryFeedback: "Shorter main set please",
    priorSessions: [
      {
        sessionId: "session-1",
        acceptedAt: "2026-04-26T10:00:00.000Z",
        status: "skipped",
        title: "Long aerobic set",
        focus: "stamina",
        totalDistance: 2000,
        variationNote: "Long repeats",
        feedbackText: "Too long after school",
        setIds: ["swim-set-zeta"],
        questionnaireSnapshot: null
      }
    ],
    candidates: [
      {
        id: "swim-set-zeta",
        text: "10 x 100 free",
        type: "main",
        reps: 10,
        distance: 100,
        distance_unit: "m",
        total_distance: 1000,
        intensity: "moderate",
        time_target: null,
        training_focus: ["stamina"],
        training_focus_certainty: { stamina: 0.8 },
        equipment: [],
        strokes: ["Freestyle"],
        rest: "20s",
        tags: [],
        source: "example"
      }
    ]
  });

  assert.equal(request.retryFeedback, "Shorter main set please");
  assert.deepEqual(request.feedbackSignals.avoidSetIds, ["swim-set-zeta"]);
  assert.equal(request.candidateSets[0].id, "swim-set-zeta");
  assert.equal(request.candidateSets[0].role, "main");
  assert.equal(request.candidateSets[0].reps, 10);
  assert.equal(request.candidateSets[0].distance, 100);
  assert.equal(request.candidateSets[0].distanceUnit, "m");
  assert.ok(!("textSummary" in request.candidateSets[0]));
});

test("buildStructuredCandidateSet keeps only structured fields for Bedrock", () => {
  const structured = buildStructuredCandidateSet({
    id: "swim-set-1",
    text: "4 x 50 backstroke drill",
    type: "preset",
    reps: 4,
    distance: 50,
    distance_unit: "m",
    total_distance: 200,
    time_target: null,
    intensity: "easy",
    rest: "15s",
    strokes: ["Backstroke"],
    equipment: ["Pull buoy"],
    training_focus: ["technique"],
    training_focus_certainty: { technique: 0.9 },
    tags: ["drill"],
    source: "example"
  });

  assert.deepEqual(structured, {
    id: "swim-set-1",
    role: "warmup",
    type: "preset",
    reps: 4,
    distance: 50,
    distanceUnit: "m",
    totalDistance: 200,
    intensity: "easy",
    rest: "15s",
    timeTarget: null,
    strokes: ["Backstroke"],
    equipment: ["Pull buoy"],
    trainingFocus: ["technique"],
    trainingFocusCertainty: { technique: 0.9 },
    tags: ["drill"],
    source: "example"
  });
});

test("session role mapping treats preset as warmup and cooldown as cooldown", () => {
  assert.equal(getSessionSetRole({ type: "preset" }), "warmup");
  assert.equal(getSessionSetRole({ type: "cooldown" }), "cooldown");
  assert.equal(getSessionSetRole({ type: "kick" }), "main");
  assert.equal(getSessionSetRole({ type: "pull" }), "main");
});

test("mergeRequiredRoleSets keeps warmup, main, and cooldown in the shortlist", () => {
  const merged = mergeRequiredRoleSets([
    { id: "main-1", type: "main", score: 10 },
    { id: "cool-1", type: "cooldown", score: 9 },
    { id: "preset-1", type: "preset", score: 1 },
    { id: "kick-1", type: "kick", score: 8 }
  ]);

  const mergedRoles = new Set(merged.map((set) => getSessionSetRole(set)));
  assert.ok(mergedRoles.has("warmup"));
  assert.ok(mergedRoles.has("main"));
  assert.ok(mergedRoles.has("cooldown"));
});

test("shortlistSwimSets includes warmup, main, and cooldown candidates", () => {
  const shortlisted = shortlistSwimSets({
    "current-level": "B",
    "goal-level": "C",
    "improvement-area": "C"
  }, []);

  const shortlistedRoles = new Set(shortlisted.map((set) => getSessionSetRole(set)));
  assert.ok(shortlistedRoles.has("warmup"));
  assert.ok(shortlistedRoles.has("main"));
  assert.ok(shortlistedRoles.has("cooldown"));
});
