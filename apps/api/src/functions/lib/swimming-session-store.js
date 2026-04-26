const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand
} = require("@aws-sdk/lib-dynamodb");
const { randomUUID } = require("crypto");

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function buildUserId(username) {
  return `USER#${username}`;
}

function buildSportPrefix(sportId) {
  return `SPORT#${sportId}#SESSION#`;
}

function buildSessionSortKey(sportId, sessionId, acceptedAt) {
  return `${buildSportPrefix(sportId)}${acceptedAt}#${sessionId}`;
}

function toSessionSummary(item) {
  return {
    sessionId: item.sessionId,
    sportId: item.sportId,
    status: item.status,
    acceptedAt: item.acceptedAt,
    completedAt: item.completedAt ?? null,
    skippedAt: item.skippedAt ?? null,
    feedbackText: item.feedbackText ?? "",
    recommendation: item.recommendation,
    questionnaireSnapshot: item.questionnaireSnapshot ?? null
  };
}

async function listSportSessions(tableName, username, sportId) {
  const sessions = [];
  let lastEvaluatedKey;

  do {
    const response = await dynamoClient.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "userId = :userId AND begins_with(sortKey, :sortKeyPrefix)",
      ExpressionAttributeValues: {
        ":userId": buildUserId(username),
        ":sortKeyPrefix": buildSportPrefix(sportId)
      },
      ScanIndexForward: false,
      ExclusiveStartKey: lastEvaluatedKey
    }));

    sessions.push(...(response.Items ?? []).map(toSessionSummary));
    lastEvaluatedKey = response.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return sessions;
}

async function saveAcceptedSession(tableName, username, sportId, recommendation, questionnaireSnapshot) {
  const acceptedAt = new Date().toISOString();
  const sessionId = randomUUID();
  const item = {
    userId: buildUserId(username),
    sortKey: buildSessionSortKey(sportId, sessionId, acceptedAt),
    sessionId,
    sportId,
    entityType: "session",
    status: "planned",
    acceptedAt,
    recommendation,
    questionnaireSnapshot
  };

  await dynamoClient.send(new PutCommand({
    TableName: tableName,
    Item: item
  }));

  return toSessionSummary(item);
}

async function updateSessionFeedback(tableName, username, sportId, sessionId, outcome, feedbackText) {
  const sessions = await listSportSessions(tableName, username, sportId);
  const session = sessions.find((entry) => entry.sessionId === sessionId);

  if (!session) {
    return {
      status: "not_found",
      session: null
    };
  }

  if (session.status !== "planned") {
    return {
      status: "not_pending",
      session: session
    };
  }

  const now = new Date().toISOString();
  const status = outcome === "did-not-do" ? "skipped" : "completed";

  const response = await dynamoClient.send(new UpdateCommand({
    TableName: tableName,
    Key: {
      userId: buildUserId(username),
      sortKey: buildSessionSortKey(sportId, session.sessionId, session.acceptedAt)
    },
    UpdateExpression: "SET #status = :status, feedbackText = :feedbackText, completedAt = :completedAt, skippedAt = :skippedAt",
    ExpressionAttributeNames: {
      "#status": "status"
    },
    ExpressionAttributeValues: {
      ":status": status,
      ":feedbackText": feedbackText,
      ":completedAt": status === "completed" ? now : null,
      ":skippedAt": status === "skipped" ? now : null
    },
    ReturnValues: "ALL_NEW"
  }));

  return {
    status: response.Attributes ? "updated" : "not_found",
    session: response.Attributes ? toSessionSummary(response.Attributes) : null
  };
}

async function resetSportSessions(tableName, username, sportId) {
  const sessions = await listSportSessions(tableName, username, sportId);

  if (!sessions.length) {
    return;
  }

  const deleteRequests = sessions.map((session) => ({
    DeleteRequest: {
      Key: {
        userId: buildUserId(username),
        sortKey: buildSessionSortKey(sportId, session.sessionId, session.acceptedAt)
      }
    }
  }));

  for (let index = 0; index < deleteRequests.length; index += 25) {
    const batch = deleteRequests.slice(index, index + 25);
    let pendingBatch = batch;

    while (pendingBatch.length) {
      const response = await dynamoClient.send(new BatchWriteCommand({
        RequestItems: {
          [tableName]: pendingBatch
        }
      }));

      pendingBatch = response.UnprocessedItems?.[tableName] ?? [];
    }
  }
}

module.exports = {
  listSportSessions,
  resetSportSessions,
  saveAcceptedSession,
  updateSessionFeedback
};
