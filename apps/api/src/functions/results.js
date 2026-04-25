const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");

const jsonHeaders = {
  "content-type": "application/json"
};

const tableName = process.env.RESULTS_TABLE_NAME;
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function createResponse(statusCode, body) {
  return {
    statusCode,
    headers: jsonHeaders,
    body: JSON.stringify(body)
  };
}

function getUserId(event) {
  return event?.requestContext?.authorizer?.jwt?.claims?.sub ?? null;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeAnswersBySport(value) {
  if (!isPlainObject(value)) {
    throw new Error("answersBySport must be an object keyed by sport id.");
  }

  return Object.entries(value).reduce((accumulator, [sportId, answers]) => {
    if (typeof sportId !== "string" || !sportId.trim()) {
      throw new Error("Each sport id must be a non-empty string.");
    }

    if (!isPlainObject(answers)) {
      throw new Error(`Answers for sport '${sportId}' must be an object keyed by question id.`);
    }

    accumulator[sportId] = Object.entries(answers).reduce((answerAccumulator, [questionId, answer]) => {
      if (typeof questionId !== "string" || !questionId.trim()) {
        throw new Error(`Each question id for sport '${sportId}' must be a non-empty string.`);
      }

      if (typeof answer !== "string" || !answer.trim()) {
        throw new Error(`Each answer for sport '${sportId}' question '${questionId}' must be a non-empty string.`);
      }

      answerAccumulator[questionId] = answer;
      return answerAccumulator;
    }, {});

    return accumulator;
  }, {});
}

function parseRequestBody(event) {
  if (!event?.body) {
    throw new Error("Request body is required.");
  }

  let parsedBody;

  try {
    parsedBody = JSON.parse(event.body);
  } catch {
    throw new Error("Request body must be valid JSON.");
  }

  return {
    answersBySport: sanitizeAnswersBySport(parsedBody.answersBySport ?? {})
  };
}

async function handleGet(userId) {
  const response = await dynamoClient.send(new GetCommand({
    TableName: tableName,
    Key: {
      userId
    }
  }));

  return createResponse(200, {
    answersBySport: response.Item?.answersBySport ?? {},
    updatedAt: response.Item?.updatedAt ?? null,
    createdAt: response.Item?.createdAt ?? null
  });
}

async function handlePut(userId, event) {
  const { answersBySport } = parseRequestBody(event);
  const now = new Date().toISOString();

  const response = await dynamoClient.send(new UpdateCommand({
    TableName: tableName,
    Key: {
      userId
    },
    UpdateExpression: "SET answersBySport = :answersBySport, updatedAt = :updatedAt, createdAt = if_not_exists(createdAt, :createdAt)",
    ExpressionAttributeValues: {
      ":answersBySport": answersBySport,
      ":updatedAt": now,
      ":createdAt": now
    },
    ReturnValues: "ALL_NEW"
  }));

  return createResponse(200, {
    answersBySport: response.Attributes?.answersBySport ?? {},
    updatedAt: response.Attributes?.updatedAt ?? now,
    createdAt: response.Attributes?.createdAt ?? now
  });
}

exports.handler = async (event) => {
  if (!tableName) {
    return createResponse(500, {
      message: "RESULTS_TABLE_NAME is not configured."
    });
  }

  const userId = getUserId(event);

  if (!userId) {
    return createResponse(401, {
      message: "Unauthorized"
    });
  }

  try {
    if (event?.requestContext?.http?.method === "GET") {
      return await handleGet(userId);
    }

    if (event?.requestContext?.http?.method === "PUT") {
      return await handlePut(userId, event);
    }

    return createResponse(405, {
      message: "Method not allowed"
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("Request body")) {
      return createResponse(400, {
        message: error.message
      });
    }

    if (error instanceof Error && error.message.includes("must be")) {
      return createResponse(400, {
        message: error.message
      });
    }

    return createResponse(500, {
      message: error instanceof Error ? error.message : "Unable to process results request."
    });
  }
};
