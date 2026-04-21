function randomHex(length) {
  let result = "";
  for (let i = 0; i < length; i += 1) {
    result += Math.floor(Math.random() * 16).toString(16);
  }
  return result;
}

export function createId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(16)}-${randomHex(4)}-${randomHex(4)}-${randomHex(4)}-${randomHex(12)}`;
}
