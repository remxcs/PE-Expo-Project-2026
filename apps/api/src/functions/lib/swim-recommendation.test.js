const test = require("node:test");
const assert = require("node:assert/strict");

const { buildStableSwimSetId } = require("./swim-library");
const {
  buildRecommendationRequest,
  deriveFeedbackSignals,
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
        total_distance: 1000,
        intensity: "moderate",
        training_focus: ["stamina"],
        equipment: [],
        strokes: ["Freestyle"],
        rest: "20s"
      }
    ]
  });

  assert.equal(request.retryFeedback, "Shorter main set please");
  assert.deepEqual(request.feedbackSignals.avoidSetIds, ["swim-set-zeta"]);
  assert.equal(request.candidateSets[0].id, "swim-set-zeta");
});
