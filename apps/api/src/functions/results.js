const {
  getUsernameFromEvent,
  loadQuestionnaireResults,
  parseQuestionnaireRequestBody,
  saveQuestionnaireResults
} = require("./lib/questionnaire-store");

const jsonHeaders = {
  "content-type": "application/json"
};

const userPoolId = process.env.USER_POOL_ID;

function createResponse(statusCode, body) {
  return {
    statusCode,
    headers: jsonHeaders,
    body: JSON.stringify(body)
  };
}

async function handleGet(username) {
  return createResponse(200, await loadQuestionnaireResults(userPoolId, username));
}

async function handlePut(username, event) {
  const { answersBySport } = parseQuestionnaireRequestBody(event);
  const existingResults = await loadQuestionnaireResults(userPoolId, username);
  return createResponse(200, await saveQuestionnaireResults(userPoolId, username, answersBySport, existingResults));
}

exports.handler = async (event) => {
  if (!userPoolId) {
    return createResponse(500, {
      message: "USER_POOL_ID is not configured."
    });
  }

  const username = getUsernameFromEvent(event);

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
    if (error instanceof Error && (error.message.includes("Request body") || error.message.includes("must be") || error.message.includes("too large"))) {
      return createResponse(400, {
        message: error.message
      });
    }

    return createResponse(500, {
      message: "Unable to process results request."
    });
  }
};
