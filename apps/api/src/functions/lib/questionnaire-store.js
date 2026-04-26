const {
  AdminGetUserCommand,
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient
} = require("@aws-sdk/client-cognito-identity-provider");

const QUESTIONNAIRE_ATTRIBUTE = "profile";
const cognitoClient = new CognitoIdentityProviderClient({});
const ANSWER_ID_PATTERN = /^[A-Z0-9-]{1,12}$/;

function getUsernameFromEvent(event) {
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

      if (!ANSWER_ID_PATTERN.test(answer.trim())) {
        throw new Error(`Answer '${answer}' for sport '${sportId}' question '${questionId}' is not a valid option id.`);
      }

      answerAccumulator[questionId] = answer.trim();
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

function parseQuestionnaireRequestBody(event) {
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

async function loadQuestionnaireResults(userPoolId, username) {
  const response = await cognitoClient.send(new AdminGetUserCommand({
    UserPoolId: userPoolId,
    Username: username
  }));

  return parseStoredResults(getAttributeValue(response.UserAttributes, QUESTIONNAIRE_ATTRIBUTE));
}

async function saveQuestionnaireResults(userPoolId, username, answersBySport, existingResults) {
  const updatedAt = new Date().toISOString();
  const storedResults = {
    answersBySport,
    updatedAt,
    createdAt: existingResults?.createdAt ?? updatedAt
  };
  const storedValue = JSON.stringify(storedResults);

  if (storedValue.length > 2048) {
    throw new Error("Questionnaire results are too large to store in the current Cognito attribute.");
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

  return storedResults;
}

module.exports = {
  getUsernameFromEvent,
  loadQuestionnaireResults,
  parseQuestionnaireRequestBody,
  saveQuestionnaireResults,
  sanitizeAnswersBySport
};
