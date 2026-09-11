const crypto = require('crypto');

function generateKeypair() {
  return crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

function sign(payload, privateKeyPem) {
  const { signature: _, ...toSign } = payload;
  return crypto.sign(null, Buffer.from(JSON.stringify(toSign)), privateKeyPem).toString('base64');
}

function verify(payload, signature, publicKeyPem) {
  try {
    const { signature: _, ...toVerify } = payload;
    return crypto.verify(null, Buffer.from(JSON.stringify(toVerify)), publicKeyPem, Buffer.from(signature, 'base64'));
  } catch { return false; }
}

function signChallenge(challenge, privateKeyPem) {
  return crypto.sign(null, Buffer.from(challenge), privateKeyPem).toString('base64');
}

function verifyChallenge(challenge, response, publicKeyPem) {
  try { return crypto.verify(null, Buffer.from(challenge), publicKeyPem, Buffer.from(response, 'base64')); }
  catch { return false; }
}

module.exports = { generateKeypair, sign, verify, signChallenge, verifyChallenge };
