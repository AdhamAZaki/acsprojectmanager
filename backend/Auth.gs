/**
 * Authentication against the Team sheet (Username + Password columns).
 *
 * An admin types a plain password into the Password cell. On the user's
 * first successful login it is replaced by a salted hash ("$h1$salt$hash"),
 * so from then on nobody can read it from the Sheet. To reset a password,
 * type a new plain one into the cell.
 *
 * After a successful login we issue our own HMAC-signed session token.
 */

const SESSION_HOURS = 12;
const HASH_PREFIX = '$h1$';
const HASH_ROUNDS = 1000;
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_SECONDS = 15 * 60;

function actionLogin(payload) {
  const username = normUser_(payload.username);
  const password = String(payload.password || '');
  if (!username || !password) throw new AppError('Enter your username and password.', 401);

  const cache = CacheService.getScriptCache();
  const failKey = 'fail:' + username;
  const fails = Number(cache.get(failKey) || 0);
  if (fails >= MAX_FAILED_LOGINS) {
    throw new AppError('Too many failed attempts. Try again in 15 minutes.', 429);
  }

  return withLock_(() => {
    const row = readTable_('Team').find(r => same_(r.Username, username));
    const ok = row && isActive_(row.Active) && checkPassword_(password, String(row.Password || ''));
    if (!ok) {
      cache.put(failKey, String(fails + 1), LOCKOUT_SECONDS);
      throw new AppError('Wrong username or password.', 401);
    }
    cache.remove(failKey);

    // First login after an admin set a plain password: store it hashed instead.
    if (!isHashed_(row.Password)) {
      writeRecord_('Team', Object.assign({}, row, { Password: hashPassword_(password) }), row._row);
    }
    const member = mapMember_(row);
    return {
      token: createSession_(member.username),
      user: { username: member.username, name: member.name, role: member.role },
    };
  });
}

function actionChangePassword(p, user) {
  const current = String(p.current || '');
  const next = String(p.next || '');
  if (next.length < 8) throw new AppError('The new password must be at least 8 characters.');

  return withLock_(() => {
    const row = readTable_('Team').find(r => same_(r.Username, user.username));
    if (!row || !checkPassword_(current, String(row.Password || ''))) {
      throw new AppError('Your current password is not correct.');
    }
    writeRecord_('Team', Object.assign({}, row, { Password: hashPassword_(next) }), row._row);
    return { changed: true };
  });
}

// ---------- Passwords ----------

function isHashed_(stored) {
  return String(stored || '').indexOf(HASH_PREFIX) === 0;
}

function hashPassword_(password, salt) {
  salt = salt || Utilities.getUuid().replace(/-/g, '');
  let digest = password;
  for (let i = 0; i < HASH_ROUNDS; i++) {
    digest = Utilities.base64Encode(Utilities.computeHmacSha256Signature(digest, salt));
  }
  return HASH_PREFIX + salt + '$' + digest;
}

function checkPassword_(password, stored) {
  if (!stored) return false;
  if (!isHashed_(stored)) return safeEqual_(password, stored);
  const salt = stored.slice(HASH_PREFIX.length).split('$')[0];
  return safeEqual_(hashPassword_(password, salt), stored);
}

// ---------- Sessions ----------

function createSession_(username) {
  const body = Utilities.base64EncodeWebSafe(
    JSON.stringify({ u: username, x: Date.now() + SESSION_HOURS * 3600 * 1000 }),
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
  const member = findMember_(data.u);
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
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function normUser_(v) {
  return String(v || '').trim().toLowerCase();
}
