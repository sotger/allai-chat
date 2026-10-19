/**
 * Cookie names that mean "this profile is signed in to Google". Google uses
 * several generations of session cookies; checking a few stable ones avoids
 * copying boring preference cookies (NID, consent, language) around.
 */
const AUTH_COOKIE_NAMES = [
  'SID',
  'HSID',
  'SSID',
  'APISID',
  'SAPISID',
  '__Secure-1PSID',
  '__Secure-3PSID',
  '__Secure-1PSIDTS',
  '__Secure-3PSIDTS',
  '__Secure-1PSIDCC',
  '__Secure-3PSIDCC'
];

export function isGoogleAuthCookieName(name: string): boolean {
  return AUTH_COOKIE_NAMES.includes(name);
}
