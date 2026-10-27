// Every expected failure carries the factoryctl exit code (see references/state.md).
export class Fail extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
