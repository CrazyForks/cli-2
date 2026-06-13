export function formatD1List(body) {
  const databases = Array.isArray(body.databases) ? body.databases : [];
  if (databases.length === 0) return ["(no d1 databases)"];
  return databases.map((db) =>
    `${db.databaseId}\tname=${db.databaseName || "-"}\tcreated=${db.createdAt || "-"}`
  );
}

export function formatD1Execute(body) {
  return [JSON.stringify(body.result, null, 2)];
}

export function formatD1MigrationList(body) {
  const migrations = Array.isArray(body.migrations) ? body.migrations : [];
  if (migrations.length === 0) return ["(no d1 migrations applied)"];
  return migrations.map((migration) =>
    `${migration.id}\tapplied=${migration.appliedAt || "-"}\tchecksum=${migration.checksum || "-"}`
  );
}

export function formatD1MigrationStatus(body) {
  const migrations = Array.isArray(body.migrations) ? body.migrations : [];
  if (migrations.length === 0) return ["(no local migrations)"];
  return migrations.map((migration) =>
    `${migration.id}\tstate=${migration.state}\tapplied=${migration.appliedAt || "-"}`
  );
}

export function formatD1MigrationApply(body) {
  const applied = Array.isArray(body.applied) ? body.applied : [];
  const skipped = Array.isArray(body.skipped) ? body.skipped : [];
  if (applied.length === 0 && skipped.length === 0) return ["(no migrations applied)"];
  return [
    ...applied.map((migration) =>
      `Applied ${migration.id}\tstatements=${migration.statementCount ?? "-"}`
    ),
    ...skipped.map((migration) => `Skipped ${migration.id}\talready applied`),
  ];
}
