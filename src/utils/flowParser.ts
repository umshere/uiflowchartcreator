import path from "path";
import axios from "axios";
import {
  RepoContents,
  fetchLocalRepoContents,
  fetchGitHubRepoContents,
} from "./repoHandlers.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

export interface ComponentInfo {
  name: string;
  type: "page" | "layout" | "component";
  filePath: string;
  imports: string[];
  children: ComponentInfo[];
}

export async function parseUIFlow(
  contents: RepoContents[],
  isLocal: boolean,
  fileExtensions: string[] = ["js", "jsx", "ts", "tsx"]
): Promise<string> {
  console.log(
    `[MCP] Parsing UI flow with extensions: ${fileExtensions.join(", ")}`
  );

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
          try {
            const response = await axios.get(item.download_url || "");
            content = response.data;
          } catch (error) {
            console.warn(
              `[MCP] Failed to fetch content for ${item.name}: ${error}`
            );
            continue;
          }
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

  return JSON.stringify(rootComponents, null, 2);
}

function getComponentType(
  componentPath: string
): "page" | "layout" | "component" {
  // Special handling for App component
  if (componentPath.toLowerCase().includes("app")) {
    return "page";
  }

  // Detect pages based on common patterns
  if (
    componentPath.includes("pages") ||
    componentPath.includes("views") ||
    componentPath.toLowerCase().includes("meals")
  ) {
    return "page";
  }

  // Detect layouts based on common patterns
  if (
    componentPath.includes("layouts") ||
    componentPath.toLowerCase().includes("header")
  ) {
    return "layout";
  }

  // Default to component
  return "component";
}

export function generateMermaidFlowchart(components: ComponentInfo[]): string {
  let chart = "flowchart TD\n";

  // Create a map of all components for quick lookup
  const componentMap = new Map<string, ComponentInfo>();
  components.forEach((component) => {
    componentMap.set(component.name, component);
  });

  // Create nodes with proper styling and hierarchy
  const createNode = (component: ComponentInfo, depth: number = 0): string => {
    const nodeId = component.name.replace(/[^a-zA-Z0-9]/g, "_");
    const indent = "  ".repeat(depth);

    // Determine node style based on type
    let nodeStyle = "";
    switch (component.type) {
      case "page":
        nodeStyle = "(( ))";
        break;
      case "layout":
        nodeStyle = "{{ }}";
        break;
      default:
        nodeStyle = "[/ /]";
    }

    // Add node with proper indentation
    chart += `${indent}${nodeId}${nodeStyle}["${component.name} (${component.type})"]\n`;

    // Recursively process children
    component.children.forEach((child) => {
      const childComponent = componentMap.get(child.name);
      if (childComponent) {
        createNode(childComponent, depth + 1);
      }
    });

    return nodeId;
  };

  // Find root components (those with no parents)
  const rootComponents = components.filter(
    (component) =>
      !components.some((c) =>
        c.children.some((child) => child.name === component.name)
      )
  );

  // Start building the chart from root components
  rootComponents.forEach((component) => {
    createNode(component);
  });

  // Create relationships with labels
  components.forEach((component) => {
    const parentId = component.name.replace(/[^a-zA-Z0-9]/g, "_");

    component.children.forEach((child) => {
      const childId = child.name.replace(/[^a-zA-Z0-9]/g, "_");
      const relationshipType = determineRelationshipType(component, child);
      chart += `  ${parentId} -->|${relationshipType}| ${childId}\n`;
    });
  });

  // Validate Mermaid.js syntax
  try {
    // Basic validation - check for required elements
    if (!chart.includes("flowchart TD")) {
      throw new Error("Missing flowchart declaration");
    }
    if (!chart.match(/\[.*\]/)) {
      throw new Error("Missing node definitions");
    }
    if (!chart.match(/-->|--/)) {
      throw new Error("Missing relationship definitions");
    }
  } catch (error) {
    console.error("[MCP] Mermaid.js validation error:", error);
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to generate valid Mermaid.js chart: ${error}`
    );
  }

  return chart;
}

function determineRelationshipType(
  parent: ComponentInfo,
  child: ComponentInfo
): string {
  if (parent.type === "layout" && child.type === "page") {
    return "contains";
  }
  if (parent.type === "page" && child.type === "component") {
    return "uses";
  }
  if (parent.type === "component" && child.type === "component") {
    return "composes";
  }
  return "relates to";
}
