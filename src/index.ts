#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs/promises";
import path from "path";
import {
  fetchLocalRepoContents,
  fetchGitHubRepoContents,
  RepoContents,
} from "./utils/repoHandlers.js";
import { parseUIFlow, generateMermaidFlowchart } from "./utils/flowParser.js";

// Initialize MCP server with capabilities
const server = new Server(
  {
    name: "uiflowchartcreator",
    version: "1.0.1",
    capabilities: {
      resources: {
        "ui-flow": {
          name: "UI Flow Resource",
          description: "Access generated UI flow diagrams",
          uriTemplate: "ui-flow://{owner}/{repo}",
        },
      },
      tools: {
        generate_ui_flow: {
          name: "generate_ui_flow",
          description:
            "Generate a UI flow diagram by analyzing React/Angular repositories. This tool scans the codebase to identify components, their relationships, and the overall UI structure.",
          inputSchema: {
            type: "object",
            properties: {
              repoPath: {
                type: "string",
                description:
                  "Path to local repository or empty string for GitHub repos",
              },
              isLocal: {
                type: "boolean",
                description:
                  "Whether to analyze a local repository (true) or GitHub repository (false)",
              },
              owner: {
                type: "string",
                description:
                  "GitHub repository owner (required if isLocal is false)",
              },
              repo: {
                type: "string",
                description:
                  "GitHub repository name (required if isLocal is false)",
              },
              fileExtensions: {
                type: "array",
                items: { type: "string" },
                description:
                  "List of file extensions to analyze (e.g., ['js', 'jsx', 'ts', 'tsx'] for React, ['ts', 'html'] for Angular)",
                default: ["js", "jsx", "ts", "tsx"],
              },
            },
            required: ["repoPath", "isLocal"],
            additionalProperties: false,
          },
        },
      },
    },
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  console.log("[MCP] Listing available tools");
  return {
    tools: [
      {
        name: "generate_ui_flow",
        description:
          "Generate a UI flow diagram by analyzing React/Angular repositories. This tool scans the codebase to identify components, their relationships, and the overall UI structure.",
        inputSchema: {
          type: "object",
          properties: {
            repoPath: {
              type: "string",
              description:
                "Path to local repository or empty string for GitHub repos",
            },
            isLocal: {
              type: "boolean",
              description:
                "Whether to analyze a local repository (true) or GitHub repository (false)",
            },
            owner: {
              type: "string",
              description:
                "GitHub repository owner (required if isLocal is false)",
            },
            repo: {
              type: "string",
              description:
                "GitHub repository name (required if isLocal is false)",
            },
            fileExtensions: {
              type: "array",
              items: { type: "string" },
              description:
                "List of file extensions to analyze (e.g., ['js', 'jsx', 'ts', 'tsx'] for React, ['ts', 'html'] for Angular)",
              default: ["js", "jsx", "ts", "tsx"],
            },
          },
          required: ["repoPath", "isLocal"],
          additionalProperties: false,
        },
      },
    ],
  };
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  console.log("[MCP] Received tool request:", request.params.name);

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

  try {
    let contents: RepoContents[];
    if (isLocal) {
      contents = await fetchLocalRepoContents(repoPath);
    } else {
      if (!owner || !repo) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Owner and repo are required for GitHub repositories"
        );
      }
      contents = await fetchGitHubRepoContents(owner, repo);
    }

    const components = await parseUIFlow(contents, isLocal, fileExtensions);
    const mermaidChart = generateMermaidFlowchart(JSON.parse(components));

    // Determine output path based on repository type
    const outputPath = isLocal
      ? path.join(repoPath, "userflo.md")
      : path.join(process.cwd(), "userflo.md");
    const flowDescription = `# UI Flow Diagram\n\nThis document describes the UI flow of the application.\n\n`;
    const fullContent =
      flowDescription + "```mermaid\n" + mermaidChart + "\n```\n\n";

    await fs.writeFile(outputPath, fullContent);
    console.log(`[MCP] UI flow saved to ${outputPath}`);

    return {
      content: [
        {
          type: "text",
          text: mermaidChart,
        },
      ],
    };
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to generate UI flow: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
});

// Handle resource access
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  console.log("[MCP] Received resource request:", request.params.uri);

  const match = request.params.uri.match(/^ui-flow:\/\/([^\/]+)\/([^\/]+)$/);
  if (!match) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Invalid resource URI format: ${request.params.uri}`
    );
  }

  const [, owner, repo] = match;
  try {
    const contents = await fetchGitHubRepoContents(owner, repo);
    const uiFlowJson = await parseUIFlow(contents, false);

    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: "application/json",
          text: uiFlowJson,
        },
      ],
    };
  } catch (error) {
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to read UI flow resource: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.log("[MCP] UI Flow Chart Creator server running on stdio");
}

run().catch((error) => {
  console.error("[MCP] Fatal error:", error);
  process.exit(1);
});

// Export to make it a proper ES module
export { server, run };
