import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The shape of the deployable tree.
 *
 * These assert things a unit test cannot normally see -- the contents of a
 * schema file and a Dockerfile -- and they exist because the failure they
 * guard against is invisible until a container is running in production.
 *
 * The API image is a `pnpm deploy --prod` of this workspace. Under pnpm, a
 * generator with no explicit `output` writes the Prisma client to
 * `node_modules/.pnpm/@prisma+client@<version>_<peer hash>/node_modules/.prisma`.
 * The hash covers the resolved peer dependencies, so the directory is renamed
 * by an unrelated dependency bump; no Dockerfile can name it; and `pnpm deploy`
 * rebuilds that tree from the store, where the generated output has never
 * existed. What lands in the pruned tree instead is the placeholder client
 * whose every export throws "@prisma/client did not initialize yet".
 *
 * The whole failure is a path. So the path is what these test.
 */

const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, root)), "utf8");

describe("the Prisma client is generated somewhere the deploy can carry it", () => {
  const schema = read("packages/database/prisma/schema.prisma");

  it("declares an explicit generator output", () => {
    const generator = /generator\s+client\s*\{([^}]*)\}/.exec(schema)?.[1] ?? "";
    expect(generator).toMatch(/output\s*=\s*"\.\.\/generated\/client"/);
  });

  it("puts that output inside the package, not in a node_modules path", () => {
    // `../generated/client` from `prisma/` is `packages/database/generated`.
    // Anything resolving into node_modules is back in the store's territory
    // and will not survive the prune.
    const output = /output\s*=\s*"([^"]+)"/.exec(schema)?.[1] ?? "";
    expect(output.includes("node_modules")).toBe(false);
    expect(output.startsWith("../")).toBe(true);
    expect(output.split("/").filter((s) => s === "..")).toHaveLength(1);
  });

  it("ships that directory even though git ignores it", () => {
    // pnpm's injected copy honours ignore rules unless `files` overrides them,
    // and `generated` is gitignored as a build artefact. Without this entry the
    // deploy silently omits the client -- the exact bug, one layer along.
    const pkg = JSON.parse(read("packages/database/package.json")) as { files?: string[] };
    expect(pkg.files).toContain("generated");
    expect(pkg.files).toContain("dist");
    expect(pkg.files).toContain("prisma");
  });

  it("keeps a host-generated copy out of the image", () => {
    // A client generated on a developer's Mac carries a darwin-arm64 query
    // engine. Copied into a linux image it fails on the first query with a
    // message about a shared library, which names nothing useful.
    expect(read(".dockerignore")).toMatch(/^packages\/database\/generated$/m);
  });
});

describe("the API image copies the pruned tree and nothing else", () => {
  const dockerfile = read("deploy/docker/api.Dockerfile");

  it("does not reach into node_modules for the client", () => {
    // The two lines this replaces were `COPY /app/node_modules/.prisma` and a
    // separate copy of the schema. The first names a path that does not exist
    // under pnpm, so the build fails; the second was redundant once the deploy
    // carried the package.
    // Instructions only. The comments in that file describe the old path at
    // length, on purpose, so matching the whole text would fail on the
    // explanation of the bug rather than on the bug.
    const instructions = dockerfile
      .split("\n")
      .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
    const copies = instructions.filter((line) => /^COPY\s+--from=build/.test(line));
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatch(/\/pruned\s+\.\//);
    expect(instructions.join("\n")).not.toMatch(/node_modules\/\.prisma/);
  });

  it("injects the workspace packages, so no symlink points out of the tree", () => {
    // Without the flag pnpm links them by relative path out of the deploy
    // directory, which copies into the image as a dangling symlink and fails
    // on the first import.
    expect(dockerfile).toMatch(/--config\.inject-workspace-packages=true/);
  });

  it("installs openssl, which the query engine links against", () => {
    expect(dockerfile).toMatch(/install[^\n]*openssl/);
  });
});
