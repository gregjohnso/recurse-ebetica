// Native file publication reuses conversation-owned attachment admission.
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import {} from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { registerDocumentFile } from "../../../agents/runtime/attachments/document";
import { AttachmentError } from "../../../agents/runtime/attachments/base";

export function createPublish(collection: string, owner: string) {
  return defineExtension({
    name: "recurse-publish",
    tools: [
      defineTool({
        name: "publish",
        description:
          "Publish files in the operator's reply and Files pane; images display inline. Other agents need file paths, not publication. Same filename adds a version. Limits: 100 MB/file, 120 files/minute. Markdown includes direct relative images and file links beneath its folder (100 references, 100 MB combined); hidden files, symlinks, directories and outside paths are skipped with warnings. name renames one file. Text paths/links don't publish files.",
        parameters: Type.Object({
          paths: Type.Array(Type.String(), { minItems: 1 }),
          name: Type.Optional(Type.String()),
        }),
        executionMode: "sequential",
        async execute(args, api, context) {
          if (args.name !== undefined && args.paths.length > 1)
            throw new Error(
              "name renames one file; publish the others separately",
            );
          const run = await api.memo<string>(
            "recurse.publish",
            randomUUID().replaceAll("-", ""),
            context,
          );
          const lines: string[] = [];
          let failed = false;
          for (const path of args.paths) {
            try {
              const { item, included, warnings } = await registerDocumentFile(
                collection,
                owner,
                run,
                api.callId,
                path,
                api.env!.cwd,
                { name: args.name, manyPerCall: true },
              );
              lines.push(
                `Published ${item.name} (${item.size} bytes)${item.inline_media_type ? "; it displays inline" : ""}.${included ? ` Included ${included} referenced file${included === 1 ? "" : "s"}.` : ""}`,
              );
              lines.push(...warnings);
            } catch (error) {
              if (!(error instanceof AttachmentError)) throw error;
              lines.push(`publish: ${path}: ${error.message}`);
              failed = true;
              if (error.message.startsWith("publish limit reached")) break;
            }
          }
          return {
            output: [{ type: "text", text: lines.join("\n") }],
            isError: failed,
          };
        },
      }),
    ],
  });
}
