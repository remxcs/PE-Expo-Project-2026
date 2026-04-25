const {
  AdminGetUserCommand,
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient
} = require("@aws-sdk/client-cognito-identity-provider");

const jsonHeaders = {
  "content-type": "application/json"
};

const QUESTIONNAIRE_ATTRIBUTE = "profile";
const userPoolId = process.env.USER_POOL_ID;
const cognitoClient = new CognitoIdentityProviderClient({});

function createResponse(statusCode, body) {
  return {
    statusCode,
    headers: jsonHeaders,
    body: JSON.stringify(body)
  };
}

function getUsername(event) {
  const claims = event?.requestContext?.authorizer?.jwt?.claims;
  return claims?.["cognito:username"] ?? claims?.username ?? claims?.sub ?? null;
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

function parseStoredResults(attributeValue) {
  if (!attributeValue) {
    return {
      answersBySport: {},
      updatedAt: null,
      createdAt: null
    };
  }

  try {
      const parsedValue = JSON.parse(attributeValue);
      return {
        answersBySport: sanitizeAnswersBySport(parsedValue.answersBySport ?? {}),
        updatedAt: typeof parsedValue.updatedAt === "string" ? parsedValue.updatedAt : null,
        createdAt: typeof parsedValue.createdAt === "string" ? parsedValue.createdAt : null
      };
  } catch {
    return {
      answersBySport: {},
      updatedAt: null,
      createdAt: null
    };
  }
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

function getAttributeValue(userAttributes, attributeName) {
  return userAttributes?.find((attribute) => attribute.Name === attributeName)?.Value ?? "";
}

async function handleGet(username) {
  const response = await cognitoClient.send(new AdminGetUserCommand({
    UserPoolId: userPoolId,
    Username: username
  }));

  const storedResults = parseStoredResults(getAttributeValue(response.UserAttributes, QUESTIONNAIRE_ATTRIBUTE));

  return createResponse(200, storedResults);
}

async function handlePut(username, event) {
  const { answersBySport } = parseRequestBody(event);
  const existingResults = await handleGet(username);
  const existingPayload = JSON.parse(existingResults.body);
  const updatedAt = new Date().toISOString();
  const storedValue = JSON.stringify({
    answersBySport,
    updatedAt,
    createdAt: existingPayload.createdAt ?? updatedAt
  });

  if (storedValue.length > 2048) {
    return createResponse(413, {
      message: "Questionnaire results are too large to store in the current Cognito attribute."
    });
  }

  await cognitoClient.send(new AdminUpdateUserAttributesCommand({
    UserPoolId: userPoolId,
    Username: username,
    UserAttributes: [
      {
        Name: QUESTIONNAIRE_ATTRIBUTE,
        Value: storedValue
      }
    ]
  }));

  return createResponse(200, {
    answersBySport,
    updatedAt,
    createdAt: existingPayload.createdAt ?? updatedAt
  });
}

exports.handler = async (event) => {
  if (!userPoolId) {
    return createResponse(500, {
      message: "USER_POOL_ID is not configured."
    });
  }

  const username = getUsername(event);

  if (!username) {
    return createResponse(401, {
      message: "Unauthorized"
    });
  }

  try {
    if (event?.requestContext?.http?.method === "GET") {
      return await handleGet(username);
    }

    if (event?.requestContext?.http?.method === "PUT") {
      return await handlePut(username, event);
    }

    return createResponse(405, {
      message: "Method not allowed"
    });
  } catch (error) {
    if (error instanceof Error && (error.message.includes("Request body") || error.message.includes("must be"))) {
      return createResponse(400, {
        message: error.message
      });
    }

    return createResponse(500, {
      message: error instanceof Error ? error.message : "Unable to process results request."
    });
  }
};
