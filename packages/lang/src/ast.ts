// Sprout abstract syntax tree (docs/LANGUAGE.md sections 4 and 5). Plain data, no behaviour.

/** Source position: 1-based line and column; endCol is exclusive. */
export interface Pos { line: number; col: number; endCol: number }

export type BinaryOp =
  | '+' | '-' | '*' | '/' | '%'
  | '==' | '!=' | '<' | '<=' | '>' | '>='
  | 'in' | 'not in';

export type Expr =
  | { k: 'int'; v: number; pos: Pos }
  | { k: 'str'; v: string; pos: Pos }
  | { k: 'interp'; parts: (string | Expr)[]; pos: Pos }
  | { k: 'bool'; v: boolean; pos: Pos }
  | { k: 'none'; pos: Pos }
  | { k: 'name'; name: string; pos: Pos }
  | { k: 'list'; items: Expr[]; pos: Pos }
  | { k: 'record'; entries: { key: string; value: Expr }[]; pos: Pos }
  | { k: 'unary'; op: '-' | 'not'; e: Expr; pos: Pos }
  | { k: 'binary'; op: BinaryOp; l: Expr; r: Expr; pos: Pos }
  | { k: 'logic'; op: 'and' | 'or'; l: Expr; r: Expr; pos: Pos }
  | { k: 'call'; callee: Expr; args: Expr[]; pos: Pos }
  | { k: 'index'; obj: Expr; idx: Expr; pos: Pos }
  | { k: 'field'; obj: Expr; name: string; pos: Pos };

export type AssignOp = '=' | '+=' | '-=' | '*=';

export type Stmt =
  | { k: 'assign'; target: Expr; op: AssignOp; value: Expr; pos: Pos }
  | { k: 'expr'; e: Expr; command: boolean; pos: Pos }
  | { k: 'if'; branches: { cond: Expr; body: Stmt[]; pos: Pos }[]; orelse: Stmt[] | null; pos: Pos }
  | { k: 'while'; cond: Expr; body: Stmt[]; pos: Pos }
  | { k: 'forever'; body: Stmt[]; pos: Pos }
  | { k: 'times'; count: Expr; body: Stmt[]; pos: Pos }
  | { k: 'foreach'; name: string; namePos: Pos; iter: Expr; body: Stmt[]; pos: Pos }
  | { k: 'forrange'; name: string; namePos: Pos; from: Expr; to: Expr; step: Expr | null; body: Stmt[]; pos: Pos }
  | { k: 'define'; name: string; namePos: Pos; params: { name: string; pos: Pos }[]; body: Stmt[]; pos: Pos }
  | { k: 'return'; value: Expr | null; pos: Pos }
  | { k: 'break'; pos: Pos }
  | { k: 'continue'; pos: Pos }
  | { k: 'pass'; pos: Pos }
  | { k: 'stop'; pos: Pos }
  | { k: 'global'; names: { name: string; pos: Pos }[]; pos: Pos };
