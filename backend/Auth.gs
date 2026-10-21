/**
 * Authentication: verify a Zoho access token, then issue our own
 * HMAC-signed session token. Passwords never touch this app — users type
 * them into Zoho's own login page.
 */

const SESSION_HOURS = 12;

function actionLogin(payload) {
  const zohoToken = String(payload.zohoToken || '').trim();
  if (!zohoToken) throw new AppError('Missing Zoho token', 401);

  const profile = fetchZohoProfile_(zohoToken);
  const email = String(profile.Email || profile.email || '').trim().toLowerCase();
  if (!email) throw new AppError('Zoho did not return an email address. Please sign in again.', 401);

  const domain = getConfig_('ALLOWED_DOMAIN').toLowerCase();
  if (domain && !email.endsWith('@' + domain)) {
    throw new AppError('Only @' + domain + ' accounts can sign in.', 403);
  }

  const member = findMember_(email);
  if (!member) {
    throw new AppError('Your account (' + email + ') is not on the team list. Ask an admin to add you.', 403);
  }
  return { token: createSession_(email), user: member };
}

function fetchZohoProfile_(accessToken) {
  // The accounts URL comes from Script Properties only — never from the
  // client — so nobody can point verification at a server they control.
  const url = getConfig_('ZOHO_ACCOUNTS_URL').replace(/\/+$/, '') + '/oauth/user/info';
  const res = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Zoho-oauthtoken ' + accessToken },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new AppError('Zoho sign-in could not be verified. Please sign in again.', 401);
  }
  try {
    return JSON.parse(res.getContentText());
  } catch (err) {
    throw new AppError('Unexpected response from Zoho. Please sign in again.', 401);
  }
}

function createSession_(email) {
  const body = Utilities.base64EncodeWebSafe(
    JSON.stringify({ e: email, x: Date.now() + SESSION_HOURS * 3600 * 1000 }),
    Utilities.Charset.UTF_8
  );
  return body + '.' + sign_(body);
}

/** Validates the token and returns the current Team record (role may have changed). */
function requireSession_(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2 || !safeEqual_(sign_(parts[0]), parts[1])) {
    throw new AppError('Please sign in again.', 401);
  }
  let data;
  try {
    data = JSON.parse(
      Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString('UTF-8')
    );
  } catch (err) {
    throw new AppError('Please sign in again.', 401);
  }
  if (!data.x || data.x < Date.now()) {
    throw new AppError('Your session has expired. Please sign in again.', 401);
  }
  const member = findMember_(data.e);
  if (!member) throw new AppError('Your access has been removed. Contact an admin.', 401);
  return member;
}

function sign_(text) {
  return Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(text, getSessionSecret_())
  );
}

function getSessionSecret_() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('SESSION_SECRET');
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('SESSION_SECRET', secret);
  }
  return secret;
}

function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
