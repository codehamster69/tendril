# Sprout: the Tendril pseudocode language (language version 1)

Authoritative for `packages/lang`. Players program their bots in Sprout: plain-English,
indentation-based pseudocode close to Python. It replaces Lua entirely (D-021). The interpreter is
TypeScript, runs only on the player's machine (worker or CLI) and is never imported by the server.

Design goals: readable by a beginner on first sight; a real language (variables, functions, lists,
records, loops); deterministic (same world + source = same action log); can never hang the app;
debuggable (current line, variables, breakpoints, per-line heat).

## 1. A first program
```
# Walk the first plot, farming carrots forever.
repeat forever:
    for each tile in tiles():
        go_to tile
        if scan().ripe:
            harvest
        if scan().empty:
            till
            plant carrot
    go_to barn
    deposit
    sell carrot, all
```

## 2. Lexical rules
- Source is UTF-8 text, split into lines. `#` starts a comment to end of line.
- Indentation is spaces. A tab counts as 4 spaces. A line ending in `:` opens a block; the block is
  the following lines indented deeper than the opener; all lines of a block share one indentation.
  Inconsistent dedent is a compile error ("indentation does not match any outer block").
- Blank and comment-only lines are ignored for indentation. A line may continue inside `(`, `[`, `{`.
- Identifiers: `[A-Za-z_][A-Za-z0-9_]*`, case-sensitive. Keywords are lowercase and reserved:
  `if elif else while repeat forever times for each in from to step define def return break
  continue pass stop and or not is true false none set global`.
- Integers only: `0`, `42`, `1_000`. No floats, no exponent. Literal magnitude must be <= 2^53-1.
- Strings: `"..."` or `'...'`, escapes `\n \t \\ \" \'`. Double-quoted strings interpolate
  `{expression}`; `{{` and `}}` are literal braces. Single-quoted strings never interpolate.

## 3. Values
`integer`, `string`, `boolean` (`true`/`false`), `none`, `list` (mutable, ordered, 0-based),
`record` (mutable, string keys, insertion-ordered; written `{x: 1, "y": 2}`), `function`.
Lists and records are references (assignment shares). Equality `==`/`is` is structural for lists
and records, by value otherwise. Falsy: `false`, `none`, `0`, `""`, `[]`, `{}`; all else truthy.
All arithmetic results must be safe integers, else runtime error "number too large".

## 4. Expressions (lowest to highest precedence)
| level | operators |
|---|---|
| 1 | `or` |
| 2 | `and` |
| 3 | `not x` |
| 4 | `==` `!=` `<` `<=` `>` `>=` `is` `is not` `in` `not in` (non-chaining; `a < b < c` is a compile error) |
| 5 | `+` `-` (`+` also joins strings, and joins lists) |
| 6 | `*` `/` `%` (`/` is floor division; `%` result has the divisor's sign; division by 0 is a runtime error) |
| 7 | unary `-` |
| 8 | call `f(a, b)`, index `xs[i]` (negative counts from end), field `r.name` |
| 9 | literals, names, `(expr)`, `[a, b]`, `{k: v}` |

`and`/`or` short-circuit and return booleans. `x in list` membership, `"k" in record` key test,
`"ab" in "cab"` substring. String + non-string converts with `str` rules. Comparing different types
with `<` is a runtime error. Reading a missing record field gives `none`; out-of-range index is an error.

## 5. Statements
```
x = expr            set x to expr          x += expr   x -= expr   x *= expr
xs[i] = expr        r.field = expr         (targets: name, index, field chains)
if cond:  ...  elif cond: ...  else if cond: ...  else: ...
while cond: ...
repeat forever: ...
repeat n times: ...                         # n evaluated once; n <= 0 runs zero times
for each v in expr: ...                     # also `for v in expr:`; lists iterate a copy, records iterate keys, strings iterate characters
for i from a to b: ...                      # inclusive; counts down when a > b
for i from a to b step s: ...               # s != 0; a positive s with a > b runs zero times
define name(p1, p2): ...                    # also `def`; functions may recurse; defined before use at run time
return [expr]       break     continue     pass
stop                                        # this bot's program ends quietly
global name, name2                          # inside a function: assignments to these names write globals
expression                                  # usually a call
```
**Command form.** A statement that starts with a name followed by an argument list on the same line,
without parentheses, is a call: `move north`, `plant carrot`, `sell carrot, all`, `go_to 3, 4`,
`say "hello", x`. A name alone on a line (`harvest`) calls it with no arguments. The parser treats
`NAME <token>` as a command when `<token>` is a name, integer, string, `[` or `{` (not an operator,
`=`, `(`, `.` or `[` directly attached). If the name is not callable at run time: runtime error
"`x` is not a command". Command form is only for statements; inside expressions use parentheses.

**Scope.** Each bot has its own globals (top-level assignments). Inside a function, assignment creates a
local unless the name is declared `global`. Name lookup: local, then global, then built-in. Assigning to a
built-in name is a compile error. `shared` is one record shared by every bot (signals), not world state.

## 6. Built-ins
Exact list (names, args, results, docs, tick costs, examples, feature IDs) lives in
`packages/lang/src/api.ts`, which the editor, in-game reference and website all import. It must match this table.

Constants: `north east south west` (strings), crop/item names `carrot wheat clover pumpkin berry apple
honey compost`, building names `hive composter`, `barn` = `{x: 0, y: 0}`, `all` (sentinel for `sell`).

**Actions** (end this bot's turn and take ticks; see SIM_SPEC for exact effects):
| call | ticks | returns |
|---|---|---|
| `move dir` | 2 | `true` if moved |
| `till` | 3 | `true` if tilled |
| `plant crop` | 2 | `true` if planted |
| `water` | 2 | `true` |
| `harvest` | 3 | units taken (crops or honey) |
| `deposit` | 1 | units moved to the barn |
| `deliver order` (order record or id) | 2 | coins earned (0 if not delivered) |
| `wait n` | n | `true`; n >= 1; n > 1000 performs consecutive waits of at most 1000 |
| `sell item, n` / `sell item, all` | 1 | coins earned. `all` sells the whole barn stock of that item; with 0 in stock it returns 0 without acting |
| `build kind` | 4 | `true` if built |
| `clear` | 3 | `true` if something was removed |
| `compost` | 2 | compost units made |
| `fertilize` | 2 | `true` if applied |

**Farm actions** (instant, never end the turn, logged with bot -1): `buy_plot px, py` -> `true/false`,
`buy_bot` -> new bot id or `none`, `unlock name` -> `true/false`.

**Standard library actions** (written in Sprout inside the prelude, so each step costs normal ticks):
`go_to x, y` or `go_to pos` (record with x, y): walks east/west first, then north/south; returns
`true` on arrival, `false` if a move fails.

**Queries** (free, never logged, never change the world):
`scan()` and `scan_at(x, y)` -> `{x, y, tilled, crop, stage, ripe, empty, moisture, nitrogen, fatigue,
barn, building, honey}` (`crop`/`building` are names or `none`; `ripe` = stage 3; `empty` = no crop, no
building, not barn); `scan_at` of unowned land returns `none`. `position()` -> `{x, y}`, `my_id()`,
`load()` -> record item -> units (every item key present), `carried()`, `capacity()`, `tick()`,
`owns(x, y)`, `plots()` -> list of `{px, py}`, `tiles()` -> list of `{x, y}` for every owned tile in
plot purchase order then row-major, `forecast(n)` -> list of `{kind, start, end}`, `weather()`,
`orders()` -> list of `{id, crop, qty, reward, deadline}`, `stock()` -> record, `coins()`, `plot_cost()`,
`bot_cost()`, `bots()`, `unlocked(name)`, `unlock_cost(name)`, `price(item)` (on a market day: today's price in hundredths of a coin, so 200 is 2 coins; on other days the base price in whole coins).

**Utilities** (free): `say ...` / `print ...` (output line, values joined by spaces), `len`, `abs`,
`min`, `max` (args or one list), `range(n)` / `range(a, b)` (b exclusive), `append(list, v)`,
`pop(list)` (last), `insert(list, i, v)`, `remove(list, i)`, `contains(c, v)`, `keys(record)`,
`sorted(list)` (integers or strings), `reversed(list)`, `str(v)`, `int(v)` (none on bad string),
`random(n)` (deterministic: xorshift32 seeded `(worldSeed ^ (botId+1) * 0x9E3779B1) >>> 0 || 1`; returns
0..n-1), `distance(a, b)` (Manhattan, records with x, y).

Unknown direction/crop/item/building names raise a runtime error in that bot, never an illegal action.

## 7. Execution model
- One program drives every bot. Each bot runs its own interpreter instance from the top of the program;
  bots bought later start the moment they exist (resumed later in the same tick, by index order).
- Tick loop for tick T: for each bot index in order, if `busyUntil <= T` and the bot is not done:
  resume until it performs one action (logged at T), ends, errors, or exhausts its **thinking budget**.
  Then the world ticks. Farm actions inside a turn are logged at T with bot -1 and do not end the turn.
- Thinking budget: one step per statement executed and per call made. 5,000 steps in one tick without
  an action ends the bot's turn for that tick (it continues next tick, nothing logged). Infinite loops
  therefore just burn time; the app can never hang. Budget is a constant of language version 1.
- Limits (runtime errors in that bot): call depth > 200, list/record length > 100,000, string length
  > 100,000. A runtime error stops only that bot; it is reported with bot, line, column and message.
- After an app restart or a source edit every bot restarts from the top against the current world.
- Determinism: no clock, no host randomness, no host iteration-order dependence.

## 8. Errors (messages are part of the UX: plain English, name the line)
Compile errors list every problem found with line/column: unknown name ("I don't know what `plnat`
means. Did you mean `plant`?"), bad indentation, missing `:`, assigning to a built-in, locked feature.
Suggest the nearest built-in by edit distance <= 2.

## 9. Features and campaign gating
`compile(source, { features })`: when `features` is given, using a construct or built-in whose feature ID
is absent is a compile error naming the lesson that unlocks it. Feature IDs:
`commands` (actions + constants), `repeat`, `variables`, `if`, `while`, `for`, `functions`, `lists`,
`records`, `queries`, `market`, `farm`, `crew` (shared, my_id, bots, buy_bot), `weather`, `orders`,
`buildings`, `utilities`. Default (no option) = all features.

## 10. TypeScript API (`@tendril/lang`, exported from `packages/lang/src/index.ts`)
```ts
interface Diagnostic { line: number; col: number; endCol: number; message: string; severity: 'error' | 'warning' }
interface CompileOptions { features?: ReadonlySet<string> }
compile(source: string, opts?: CompileOptions): { program: Program | null; diagnostics: Diagnostic[] }
interface ScriptError { bot: number; line: number; col: number; message: string; tick: number }
interface OutputLine { bot: number; tick: number; text: string }
interface BotDebug {
  bot: number; line: number | null;
  status: 'ready' | 'busy' | 'thinking' | 'paused' | 'done' | 'error';
  vars: { name: string; value: string }[];          // locals of the top frame, then globals; values pretty-printed, max 200 chars
  stack: { fn: string; line: number }[];
}
interface StepResult { ticks: number; paused: { bot: number; line: number } | null }
interface ScriptRun {
  readonly world: World;
  pending: LogEntry[]; errors: ScriptError[]; output: OutputLine[];
  step(ticks: number): StepResult;            // advance up to `ticks` ticks; stops early only at a breakpoint
  stepLine(): StepResult;                     // run until any bot moves to a new line or the tick ends
  setBreakpoints(lines: Iterable<number>): void;
  debug(): BotDebug[];
  lineHeat(): Map<number, number>;            // steps executed per source line since creation
  takeLog(): LogEntry[];
  close(): void;
}
createRun(world: World, source: string, opts?: CompileOptions): ScriptRun   // throws CompileError{diagnostics}
API: ApiEntry[]   // from api.ts: {name, kind:'action'|'farm'|'query'|'utility'|'constant'|'keyword', signature, doc, ticks:number|'n'|0, example, feature}
LANGUAGE_VERSION = 1
```
A breakpoint pause can happen mid-tick (some bots already acted at tick T). The next `step` resumes the
paused bot exactly where it stopped, so pausing never changes the action log. Breakpoints never fire in
headless runs (CLI, goldens) unless set.
