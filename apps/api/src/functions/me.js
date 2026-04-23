const jsonHeaders = {
  "content-type": "application/json"
};

exports.handler = async (event) => {
  const claims = event?.requestContext?.authorizer?.jwt?.claims;

  if (!claims) {
    return {
      statusCode: 401,
      headers: jsonHeaders,
      body: JSON.stringify({
        message: "Unauthorized"
      })
    };
  }

  return {
    statusCode: 200,
    headers: jsonHeaders,
    body: JSON.stringify({
      sub: claims.sub,
      email: claims.email ?? null,
      emailVerified: claims.email_verified ?? null,
      givenName: claims.given_name ?? null,
      familyName: claims.family_name ?? null,
      name: claims.name ?? null,
      username: claims.username ?? claims["cognito:username"] ?? null
    })
  };
};
