import { AuthError } from "../Auth/AuthProvider.ts";

/** Parse the Azure CLI's epoch-based token expiry without accepting expired or malformed credentials. */
export const parseAzureCliAccessToken = (
  output: string,
  now: number,
): { token: string; expiresAt: number } => {
  try {
    const value: unknown = JSON.parse(output);
    if (
      value !== null &&
      typeof value === "object" &&
      "accessToken" in value &&
      typeof value.accessToken === "string" &&
      value.accessToken.length > 0 &&
      "expires_on" in value &&
      typeof value.expires_on === "number" &&
      Number.isFinite(value.expires_on) &&
      value.expires_on * 1000 > now
    ) {
      return { token: value.accessToken, expiresAt: value.expires_on * 1000 };
    }
  } catch {
    // Report malformed CLI output as an authentication error, without including tokens.
  }
  throw new AuthError({
    message: "Azure CLI returned an invalid access token.",
  });
};
