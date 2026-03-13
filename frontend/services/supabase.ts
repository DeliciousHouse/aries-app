export const AUTH_FLOW_UNAVAILABLE_MESSAGE =
  'Email/password auth is temporarily unavailable. Use Google OAuth.';

function unavailableAuthFlow(): never {
  throw new Error(AUTH_FLOW_UNAVAILABLE_MESSAGE);
}

export async function verifyLogin(email: string, password: string): Promise<boolean> {
  void email;
  void password;
  unavailableAuthFlow();
}

export async function recordLogin(email: string): Promise<void> {
  void email;
  unavailableAuthFlow();
}

export async function checkEmailExists(email: string): Promise<boolean> {
  void email;
  unavailableAuthFlow();
}

export async function registerIndividualLogin(email: string, password: string): Promise<void> {
  void email;
  void password;
  unavailableAuthFlow();
}

export async function createProfile(
  email: string,
  fullName: string,
  role: string,
  orgId: string | null
): Promise<void> {
  void email;
  void fullName;
  void role;
  void orgId;
  unavailableAuthFlow();
}

export async function createOrganization(name: string, domain: string): Promise<{ id: string }> {
  void name;
  void domain;
  unavailableAuthFlow();
}

export async function getOrganizationByDomain(domain: string): Promise<any> {
  void domain;
  unavailableAuthFlow();
}

export function isIndividualEmail(email: string): boolean {
  const providers = ['gmail.com', 'outlook.com', 'yahoo.com', 'icloud.com'];
  const domain = email.split('@')[1];
  return providers.includes(domain);
}

export async function getInvitationByToken(token: string): Promise<any> {
  void token;
  unavailableAuthFlow();
}

export async function markInvitationUsed(id: string): Promise<void> {
  void id;
  unavailableAuthFlow();
}

export async function storeEmailVerificationCode(email: string, code: string, isInvite: boolean): Promise<void> {
  void email;
  void code;
  void isInvite;
  unavailableAuthFlow();
}

export async function recordPasswordResetRequest(email: string, code: string): Promise<void> {
  void email;
  void code;
  unavailableAuthFlow();
}

export async function updateLoginPassword(email: string, password: string): Promise<void> {
  void email;
  void password;
  unavailableAuthFlow();
}

export async function markResetCodeUsed(email: string, code: string): Promise<void> {
  void email;
  void code;
  unavailableAuthFlow();
}
