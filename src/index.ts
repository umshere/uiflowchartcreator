import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import fs from "fs/promises";
import path from "path";

interface RepoContents {
  name: string;
  path: string;
  type: string;
  content?: string;
  download_url?: string;
  owner?: string;
  repo?: string;
}

async function fetchGitHubRepoContents(
  owner: string,
  repo: string,
  repoPath: string = ""
): Promise<RepoContents[]> {
  const response = await axios.get(
    `https://api.github.com/repos/${owner}/${repo}/contents/${repoPath}`
  );

  const excludeList = [
    "node_modules",
    ".git",
    "dist",
    "build",
    ".vscode",
    ".idea",
    "test",
    "__tests__",
  ];

  const excludeFiles = [".env", ".gitignore", "package-lock.json", "yarn.lock"];

  return response.data.filter((item: RepoContents) => {
    if (item.type === "dir" && excludeList.includes(item.name)) {
      return false;
    }
    if (item.type === "file" && excludeFiles.includes(item.name)) {
      return false;
    }
    return true;
  });
}

async function fetchLocalRepoContents(
  repoPath: string
): Promise<RepoContents[]> {
  const contents: RepoContents[] = [];
  const items = await fs.readdir(repoPath, { withFileTypes: true });

  const excludeList = [
    "node_modules",
    ".git",
    "dist",
    "build",
    ".vscode",
    ".idea",
    "test",
    "__tests__",
  ];

  const excludeFiles = [".env", ".gitignore", "package-lock.json", "yarn.lock"];

  for (const item of items) {
    if (
      excludeList.includes(item.name) ||
      (item.isFile() && excludeFiles.includes(item.name))
    )
      continue;

    const itemPath = path.join(repoPath, item.name);
    if (item.isDirectory()) {
      contents.push({
        name: item.name,
        path: itemPath,
        type: "dir",
      });
    } else if (item.isFile()) {
      const content = await fs.readFile(itemPath, "utf-8");
      contents.push({
        name: item.name,
        path: itemPath,
        type: "file",
        content,
      });
    }
  }

  return contents;
}

interface ComponentInfo {
  name: string;
  type: "page" | "layout" | "component";
  filePath: string;
  imports: string[];
  children: ComponentInfo[];
}

async function parseUIFlow(
  contents: RepoContents[],
  isLocal: boolean,
  fileExtensions: string[] = ["js", "jsx", "ts", "tsx"]
): Promise<string> {
  const components: { [key: string]: ComponentInfo } = {};

  async function processContents(
    currentContents: RepoContents[],
    currentPath: string = ""
  ) {
    for (const item of currentContents) {
      if (
        item.type === "file" &&
        fileExtensions.some((ext) => item.name.endsWith(`.${ext}`))
      ) {
        let content: string;
        if (isLocal) {
          content = item.content || "";
        } else {
          const response = await axios.get(item.download_url || "");
          content = response.data;
        }

        const componentName = item.name.split(".")[0];
        const componentPath = path.join(currentPath, componentName);
        const componentType = getComponentType(componentPath);

        components[componentPath] = {
          name: componentName,
          type: componentType,
          filePath: path.join(currentPath, item.name),
          imports: [],
          children: [],
        };

        // Analyze import statements
        const importMatches = content.match(
          /import\s+(\w+|\{[^}]+\})\s+from\s+['"]([^'"]+)['"]/g
        );
        if (importMatches) {
          importMatches.forEach((match) => {
            const [, importedComponent, importPath] =
              match.match(
                /import\s+(\w+|\{[^}]+\})\s+from\s+['"]([^'"]+)['"]/
              ) || [];
            if (importedComponent) {
              const cleanedImport = importedComponent
                .replace(/[{}]/g, "")
                .trim();
              const resolvedPath = path.join(
                currentPath,
                path.dirname(importPath),
                cleanedImport
              );
              components[componentPath].imports.push(resolvedPath);
            }
          });
        }
      } else if (item.type === "dir") {
        const subContents = isLocal
          ? await fetchLocalRepoContents(item.path)
          : await fetchGitHubRepoContents(
              item.owner || "",
              item.repo || "",
              item.path
            );

        await processContents(subContents, path.join(currentPath, item.name));
      }
    }
  }

  await processContents(contents);

  // Build component hierarchy
  const rootComponents: ComponentInfo[] = [];
  Object.values(components).forEach((component) => {
    component.imports.forEach((importPath) => {
      if (components[importPath]) {
        components[importPath].children.push(component);
      }
    });
    if (component.imports.length === 0) {
      rootComponents.push(component);
    }
  });

  console.log("Generated UI Flow:", JSON.stringify(rootComponents, null, 2));
  return JSON.stringify(rootComponents, null, 2);
}

function getComponentType(
  componentPath: string
): "page" | "layout" | "component" {
  if (componentPath.includes("pages")) {
    return "page";
  } else if (componentPath.includes("layouts")) {
    return "layout";
  } else {
    return "component";
  }
}

const server = new Server(
  {
    name: "uiflowchartcreator",
    version: "1.0.0",
    capabilities: {
      resources: {},
      tools: {
        generate_ui_flow: {
          name: "generate_ui_flow",
          description:
            "Generate a UI flow diagram for a local or GitHub repository",
          inputSchema: {
            type: "object",
            properties: {
              repoPath: { type: "string" },
              isLocal: { type: "boolean" },
              owner: { type: "string" },
              repo: { type: "string" },
              fileExtensions: {
                type: "array",
                items: { type: "string" },
                description:
                  "List of file extensions to include in the UI flow (e.g., ['js', 'jsx', 'ts', 'tsx'])",
              },
            },
            required: ["repoPath", "isLocal"],
          },
        },
      },
    },
  },
  { capabilities: { resources: {}, tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "generate_ui_flow",
      description:
        "Generate a UI flow diagram for a local or GitHub repository",
      inputSchema: {
        type: "object",
        properties: {
          repoPath: { type: "string" },
          isLocal: { type: "boolean" },
          owner: { type: "string" },
          repo: { type: "string" },
          fileExtensions: {
            type: "array",
            items: { type: "string" },
            description:
              "List of file extensions to include in the UI flow (e.g., ['js', 'jsx', 'ts', 'tsx'])",
          },
        },
        required: ["repoPath", "isLocal"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  console.log("Received request:", JSON.stringify(request, null, 2));

  if (request.params.name !== "generate_ui_flow") {
    throw new McpError(
      ErrorCode.MethodNotFound,
      `Unknown tool: ${request.params.name}`
    );
  }

  const args = request.params.arguments as {
    repoPath: string;
    isLocal: boolean;
    owner?: string;
    repo?: string;
    fileExtensions?: string[];
  };
  const { repoPath, isLocal, owner, repo, fileExtensions } = args;

  console.log("Processing request with args:", {
    repoPath,
    isLocal,
    owner,
    repo,
    fileExtensions,
  });

  try {
    let contents: RepoContents[];
    if (isLocal) {
      console.log("Fetching local repo contents");
      contents = await fetchLocalRepoContents(repoPath);
    } else {
      if (!owner || !repo) {
        throw new Error("Owner and repo are required for GitHub repositories");
      }
      console.log("Fetching GitHub repo contents");
      contents = await fetchGitHubRepoContents(owner, repo);
    }
    console.log("Fetched contents:", JSON.stringify(contents, null, 2));

    console.log("Parsing UI flow");
    const uiFlowJson = await parseUIFlow(contents, isLocal, fileExtensions);
    console.log("Parsed UI flow:", uiFlowJson);

    return {
      content: [
        {
          type: "text",
          text: uiFlowJson,
        },
      ],
    };
  } catch (error) {
    console.error("Error in generate_ui_flow:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: `Error generating UI flow: ${errorMessage}`,
        },
      ],
      isError: true,
    };
  }
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.log("UI Flow Chart Creator MCP server running on stdio");
}

run().catch(console.error);

// Export to make it a proper ES module
export { server, run };
