import { defineCommand, errorHandler, multiselectPrompt, relinka, runMain, selectPrompt } from "@reliverse/prompts";
import { initFile, initFiles } from "./libs/reinit/reint-impl/mod";
import { FileType, InitFileRequest } from "./libs/reinit/reint-impl/types";
import { FILE_TYPES } from "./libs/reinit/reint-impl/const";

const main = defineCommand({
  meta: {
    name: "reinit",
    version: "1.0.0",
    description: "@reliverse/reinit-cli",
  },
  args: {
    dev: {
      type: "boolean",
      description: "Runs the CLI in dev mode",
    },
    fileType: {
        type: "string",
        description: "File type to initialize (e.g. 'md:README')",
        required: false,
      },
      destDir: {
        type: "string",
        description: "Destination directory",
        default: ".",
        required: false,
      },
      multiple: {
        type: "boolean",
        description: "Whether to select multiple file types from the library",
        required: false,
        default: false,
      },
      parallel: {
        type: "boolean",
        description: "Run tasks in parallel",
        required: false,
        default: false,
      },
      concurrency: {
        type: "string",
        description: "Concurrency limit if parallel is true",
        required: false,
        default: "4",
      },
  },
  async run({ args }) {
    const { fileType, destDir, multiple, parallel, concurrency } = args;
    const concurrencyNum = Number(concurrency);

    // throw error if fileType doesn't include FILE_TYPES.type
    if (fileType && !FILE_TYPES.find((ft) => ft.type === fileType)) {
      throw new Error(`Invalid file type: ${fileType}`);
    }

    const effectiveFileType: FileType = fileType as FileType;

    if (multiple) {
      // Let the user choose multiple file types from a prompt
      const possibleTypes = FILE_TYPES.map((ft) => ft.type);
      const chosen = await multiselectPrompt({
        title: "Select file types to initialize",
        options: possibleTypes.map((pt) => ({ label: pt, value: pt })),
      });

      if (chosen.length === 0) {
        relinka("info", "No file types selected. Exiting...");
        return;
      }

      // Construct an array of requests
      const requests: InitFileRequest[] = chosen.map((ct) => ({
        fileType: ct,
        destDir,
      }));

      const results = await initFiles(requests, { parallel, concurrency: concurrencyNum });
      relinka("info-verbose", `Multiple files result: ${JSON.stringify(results)}`);
    } else {
      // Single file approach
      let finalFileType = effectiveFileType;
      if (!finalFileType) {
        // If user didn't specify, prompt for a single file type
        const possibleTypes = FILE_TYPES.map((ft) => ft.type);
        const picked = await selectPrompt({
          title: "Pick a file type to initialize",
          options: possibleTypes.map((pt) => ({ label: pt, value: pt })),
        });
        finalFileType = picked;
      }

      const result = await initFile({
        fileType: finalFileType,
        destDir,
      });
      relinka("log-verbose", `Single file result: ${JSON.stringify(result)}`);
    }
  },
});

await runMain(main).catch((error: unknown) => {
  errorHandler(
    error instanceof Error ? error : new Error(String(error)),
    "An unhandled error occurred, please report it at https://github.com/reliverse/reinit",
  );
});
