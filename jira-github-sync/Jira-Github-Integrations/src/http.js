export function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': ['application/json']
    },
    body: JSON.stringify(body)
  };
}

export function getHeaderValue(headers, requestedHeaderName) {
  const normalizedRequestedHeaderName = requestedHeaderName.toLowerCase();
  const matchingHeader = Object.entries(headers || {}).find(([headerName]) => {
    return headerName.toLowerCase() === normalizedRequestedHeaderName;
  });

  if (!matchingHeader) {
    return undefined;
  }

  const headerValue = matchingHeader[1];
  return Array.isArray(headerValue) ? headerValue[0] : headerValue;
}

export function parseJsonBody(rawBody) {
  try {
    return JSON.parse(rawBody);
  } catch (error) {
    throw new Error(`GitHub webhook body was not valid JSON: ${error.message}`);
  }
}
