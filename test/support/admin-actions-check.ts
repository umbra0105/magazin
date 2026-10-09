import ts from "typescript";

/**
 * Regula de arhitectură: în zona de admin, o server action nu poate fi exportată decât împachetată
 * cu `withPermission(...)` (importat din `lib/session`). Altfel o scriere de admin ar putea ajunge
 * apelabilă fără verificarea permisiunii pe server.
 */

export interface Violation {
  line: number;
  message: string;
}

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false);

const isCallOfWithPermission = (expr: ts.Expression | undefined): boolean =>
  !!expr &&
  ts.isCallExpression(expr) &&
  ts.isIdentifier(expr.expression) &&
  expr.expression.text === "withPermission";

export function findAdminActionViolations(fileName: string, source: string): Violation[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const violations: Violation[] = [];
  const at = (node: ts.Node, message: string) =>
    violations.push({
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      message,
    });

  let importsRealWithPermission = false;
  let declaresOwnWithPermission = false;

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) {
      const from = ts.isStringLiteral(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : "";
      const named = stmt.importClause?.namedBindings;
      if (
        /(^|\/)lib\/session$/.test(from) &&
        named &&
        ts.isNamedImports(named) &&
        named.elements.some((e) => !e.propertyName && e.name.text === "withPermission")
      ) {
        importsRealWithPermission = true;
      }
      continue;
    }

    if (ts.isVariableStatement(stmt)) {
      const exported = hasModifier(stmt, ts.SyntaxKind.ExportKeyword);
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === "withPermission") {
          declaresOwnWithPermission = true;
        }
        if (exported && !isCallOfWithPermission(decl.initializer)) {
          at(decl, `export "${decl.name.getText(sf)}" nu este împachetat cu withPermission(...)`);
        }
      }
      continue;
    }

    if (
      ts.isFunctionDeclaration(stmt) ||
      ts.isClassDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt)
    ) {
      if (stmt.name?.text === "withPermission") declaresOwnWithPermission = true;
      if (hasModifier(stmt, ts.SyntaxKind.ExportKeyword)) {
        at(
          stmt,
          `export "${stmt.name?.text ?? "default"}" nu este împachetat cu withPermission(...)`,
        );
      }
      continue;
    }

    if (ts.isExportAssignment(stmt)) {
      at(
        stmt,
        "export default interzis: folosește un export numit împachetat cu withPermission(...)",
      );
      continue;
    }

    if (ts.isExportDeclaration(stmt) && !stmt.isTypeOnly) {
      const onlyTypes =
        stmt.exportClause &&
        ts.isNamedExports(stmt.exportClause) &&
        stmt.exportClause.elements.every((e) => e.isTypeOnly);
      if (!onlyTypes) at(stmt, "re-exportul de valori e interzis (ar ocoli withPermission)");
    }
  }

  const exportsAnyAction = violations.length > 0 || /export\s+const\s/.test(source);
  if (exportsAnyAction && (!importsRealWithPermission || declaresOwnWithPermission)) {
    violations.push({
      line: 1,
      message: 'withPermission trebuie importat din "@/lib/session" (nu definit local)',
    });
  }
  return violations;
}
