export const handler = async () => {
  return {
    statusCode: 200,
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      status: "ok",
      service: "pe-expo-api",
      timestamp: new Date().toISOString()
    })
  };
};
