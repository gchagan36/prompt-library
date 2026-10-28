// factoryctl's command table and error-to-exit-code mapping. Kept in-process so tests can
// drive it directly; bin/factoryctl.mjs is a thin wrapper.
import { Fail } from "./errors.mjs";
import {
  cmdClaim, cmdCreate, cmdHash, cmdList, cmdRelease, cmdRepo, cmdRestore, cmdShow, cmdValidate
} from "./cmd-jobs.mjs";
import {
  cmdComments, cmdGap, cmdGaps, cmdLenses, cmdOwnership, cmdPlan, cmdRoster, cmdScan
} from "./cmd-routing.mjs";
import {
  cmdChip, cmdFeedback, cmdLens, cmdNote, cmdPkg, cmdRound, cmdSet, cmdSignoff, cmdSignoffCheck
} from "./cmd-state.mjs";

const COMMANDS = Object.freeze({
  repo: cmdRepo,
  create: cmdCreate,
  claim: cmdClaim,
  release: cmdRelease,
  hash: cmdHash,
  show: cmdShow,
  validate: cmdValidate,
  list: cmdList,
  set: cmdSet,
  note: cmdNote,
  plan: cmdPlan,
  pkg: cmdPkg,
  lens: cmdLens,
  round: cmdRound,
  chip: cmdChip,
  feedback: cmdFeedback,
  signoff: cmdSignoff,
  "signoff-check": cmdSignoffCheck,
  restore: cmdRestore,
  gap: cmdGap,
  gaps: cmdGaps,
  scan: cmdScan,
  roster: cmdRoster,
  ownership: cmdOwnership,
  lenses: cmdLenses,
  comments: cmdComments
});

export const USAGE = `usage: factoryctl <command> ...   (see skills/factory/references/state.md)
  <job> is <repo>/<id>. Mutating commands end with --lease <token> --expect <hash>.
  repo | create <repo> <file> [--min N] | claim <job> | release <job>
  hash <job> | show <job> | validate [<repo>] | list [--repo <repo>]
  set <job> k=v... | note <job> --text|--append <t> | note <job> --line <file> <n>
  roster <job> <repo-path> | plan <job> | pkg <job> <P> <status> | lens <job> <lens>
  round <job> | chip <job> <lens> <file> | lenses <job> | ownership <job> <P> <from> <to> [--unowned]
  comments <job> <round>
  feedback <job> <file> | signoff <job> | signoff-check <job>
  restore <job> <hash> --lease <token> | gap <job> <file> | gaps | scan <file>...
exit: 0 ok, 1 check failed, 2 invalid, 3 tampered, 4 backup tampered, 5 not found, 6 lease`;

// ctx: { env, cwd, out(line), err(line) }. Returns the exit code.
export function run(argv, ctx) {
  const [command, ...args] = argv;
  if (command === undefined || command === "help" || command === "--help") {
    ctx.err(USAGE);
    return command === undefined ? 2 : 0;
  }
  if (!Object.hasOwn(COMMANDS, command)) {
    ctx.err(`factoryctl: unknown command ${String(command).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40)}`);
    return 2;
  }
  try {
    return COMMANDS[command](ctx, args) ?? 0;
  } catch (err) {
    if (err instanceof Fail) {
      ctx.err(`factoryctl: ${err.message}`);
      return err.code;
    }
    ctx.err(`factoryctl: unexpected error: ${err.message}`);
    return 2;
  }
}
