import crypto from 'node:crypto';
import { getHeaderValue } from './http.js';

export function isValidGitHubSignature(rawBody, headers) {
  const receivedSignature = getHeaderValue(headers, 'x-hub-signature-256');

  if (!receivedSignature || !receivedSignature.startsWith('sha256=')) {
    return false;
  }

  const expectedSignature = `sha256=${crypto
    .createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET)
    .update(rawBody, 'utf8')
    .digest('hex')}`;

  const receivedSignatureBuffer = Buffer.from(receivedSignature, 'utf8');
  const expectedSignatureBuffer = Buffer.from(expectedSignature, 'utf8');

  return (
    receivedSignatureBuffer.length === expectedSignatureBuffer.length &&
    crypto.timingSafeEqual(receivedSignatureBuffer, expectedSignatureBuffer)
  );
}

export function isAllowedGitHubOrganization(repositoryOwner) {
  const configuredOrganization = process.env.GITHUB_ORGANIZATION;

  if (!configuredOrganization) {
    return true;
  }

  return repositoryOwner.toLowerCase() === configuredOrganization.trim().toLowerCase();
}

export function sanitizeErrorMessage(errorMessage) {
  if (!errorMessage) {
    return 'Unknown error';
  }

  return errorMessage
    .replace(new RegExp(escapeRegExp(process.env.GITHUB_TOKEN || 'a^'), 'g'), '[redacted-github-token]')
    .replace(
      new RegExp(escapeRegExp(process.env.GITHUB_WEBHOOK_SECRET || 'a^'), 'g'),
      '[redacted-webhook-secret]'
    );
}

export function isDebugResponseEnabled() {
  /*
   * GitHub's webhook delivery screen shows response bodies. Keeping this behind
   * an opt-in flag prevents token-adjacent debug details from leaking during
   * normal production operation.
   */
  return process.env.DEBUG_WEBHOOK_RESPONSES === 'true';
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
