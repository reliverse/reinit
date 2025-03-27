import fs from "fs-extra";
import path from "pathe";
import pMap from "p-map";
import { loadConfig } from "c12";
import { relinka, selectPrompt } from "@reliverse/prompts";
import { DestFileExistsBehaviour, InitBehaviour, InitFileRequest, InitFileResult, ReinitUserConfig } from "./types";
import { FILE_TYPES } from "./const";
import { escapeMarkdownCodeBlocks } from "./utils";
import { licenseTemplate, readmeTemplate } from "../reinit-main";

/** Creation from scratch */
export async function createFileFromScratch(
  destPath: string,
  fileType: string,
  contentCreateMode?: string,
) {
  // Ensure parent directory
  await fs.ensureDir(path.dirname(destPath));
  
  let content = "";

  switch (contentCreateMode) {
    case "license-basic":
      content = licenseTemplate;
      break;
    case "simple-readme":
      content = escapeMarkdownCodeBlocks(readmeTemplate);
      break;
    default:
      content = `// Auto-generated file for type: ${fileType}`;
      break;
  }

  await fs.outputFile(destPath, content, { encoding: "utf-8" });
}

 
/**
 * Loads user config from reinit.config.(ts|js|json...) using c12 and merges 
 * with fallback defaults. For environment-based config, extends, etc.
 * @see https://unjs.io/packages/c12
 */
async function loadReinitConfig(): Promise<ReinitUserConfig> {
  const { config } = await loadConfig<ReinitUserConfig>({
    name: "reinit", // c12 tries reinit.config, .reinitrc, etc.
    // configFile: "reinit.config", // If we want to enforce the file name
    // rcFile: ".reinitrc",         // Or a .reinitrc
    defaults: {},   // base defaults
    overrides: {},  // highest priority overrides
    dotenv: false,
    packageJson: false,
  });

  // Fallback in case user config is missing or partial
  const merged: ReinitUserConfig = {
    defaultInitBehaviour: config.defaultInitBehaviour ?? "create-if-copy-failed",
    defaultDestFileExistsBehaviour:
      config.defaultDestFileExistsBehaviour ?? "rewrite",
    parallelByDefault: config.parallelByDefault ?? false,
    parallelConcurrency: config.parallelConcurrency ?? 4,
    onFileStart: config.onFileStart,
    onFileComplete: config.onFileComplete,
  };
  return merged;
}

/** 
 * Single-file initialization using the merged config. 
 * @returns A structured result describing the operation (created, copied, skipped, error).
 */
export async function initFile(
  req: InitFileRequest,
  userCfg?: ReinitUserConfig,
): Promise<InitFileResult> {
  // Merge with user config from c12 if none provided
  const config = userCfg ?? (await loadReinitConfig());
  const initBehaviour = req.initBehaviour ?? config.defaultInitBehaviour!;
  const existsBehaviour = req.destFileExistsBehaviour ?? config.defaultDestFileExistsBehaviour!;

  // Fire "onFileStart" if provided
  config.onFileStart?.(req);

  let result: InitFileResult;
  try {
    result = await doInitFile(req, initBehaviour, existsBehaviour);
  } catch (error) {
    result = {
      requested: req,
      status: "error",
      error,
    };
  }

  // Fire "onFileComplete"
  config.onFileComplete?.(result);
  return result;
}

/**
 * Multi-file version. By default, uses the "parallelByDefault" from config.
 * If parallel is true, uses p-map with concurrency from "parallelConcurrency".
 */
export async function initFiles(
  items: InitFileRequest[],
  options?: { parallel?: boolean; concurrency?: number },
  userCfg?: ReinitUserConfig,
): Promise<InitFileResult[]> {
  const config = userCfg ?? (await loadReinitConfig());

  // Decide parallel or sequential
  const parallel = 
    typeof options?.parallel === "boolean"
      ? options.parallel
      : config.parallelByDefault;

  // Decide concurrency
  const concurrency = 
    options?.concurrency ?? config.parallelConcurrency ?? 4;

  if (parallel) {
    return pMap(
      items,
      (item) => initFile(item, config),
      { concurrency },
    );
  } else {
    const results: InitFileResult[] = [];
    for (const item of items) {
      results.push(await initFile(item, config));
    }
    return results;
  }
}

/** 
 * The main logic for creating or copying a file.
 * (Don't call this directly; call initFile or initFiles)
 */
async function doInitFile(
  req: InitFileRequest,
  initBehaviour: InitBehaviour,
  destFileExistsBehaviour: DestFileExistsBehaviour,
): Promise<InitFileResult> {
  const { fileType, destDir, options } = req;
  const { destFileName, srcCopyMode, contentCreateMode, fallbackSource } = options ?? {};

  // 1) Identify known file type ignoring case
  const knownType = FILE_TYPES.find(
    (f) => f.type.toLowerCase() === fileType.toLowerCase(),
  );
  // If not recognized, fallback to single variation = same as fileType
  let variations = knownType ? knownType.variations : [fileType];

  // Possibly prompt user if multiple variations
  let chosenVariation: string;
  if (variations.length === 1) {
    chosenVariation = variations[0];
  } else {
    chosenVariation = await selectPrompt({
      title: `Select variation for ${fileType}`,
      options: variations.map((v) => ({ label: v, value: v })),
    });
  }

  // 2) Final name
  const finalName = destFileName ?? chosenVariation;
  const destPath = path.join(destDir, finalName);

  // 3) Check if file already exists
  let alreadyExists = await fs.pathExists(destPath);
  if (alreadyExists) {
    const maybeNewDest = await handleExistingFile(destPath, destFileExistsBehaviour);
    if (!maybeNewDest) {
      // user chose skip
      return {
        requested: req,
        status: "skipped",
      };
    }
    if (maybeNewDest !== destPath) {
      // We have a new path
      alreadyExists = false;
    }
  }

  // 4) Based on initBehaviour
  switch (initBehaviour) {
    case "copy":
      return await runCopy(req, chosenVariation, destPath);
    case "create":
      return await runCreate(req, destPath);
    case "create-if-copy-failed":
    default:
      // Attempt copy, fallback to create
      try {
        return await runCopy(req, chosenVariation, destPath);
      } catch (err) {
        relinka("warn", `Copy failed for ${chosenVariation}, fallback to create...`);
        return await runCreate(req, destPath);
      }
  }
}

/** Attempt to copy from `cwd` or srcCopyMode. If that fails, fallback. */
async function runCopy(
  req: InitFileRequest,
  chosenVariation: string,
  destPath: string,
): Promise<InitFileResult> {
  const { srcCopyMode, fallbackSource } = req.options ?? {};
  try {
    await tryCopy(chosenVariation, srcCopyMode, destPath);
    relinka("info", `Copied file: ${chosenVariation} -> ${destPath}`);
    return {
      requested: req,
      finalPath: destPath,
      status: "copied",
    };
  } catch (primaryErr) {
    // If fallback is provided, attempt that
    if (fallbackSource) {
      relinka("warn", `Primary copy failed, trying fallback: ${fallbackSource}`);
      try {
        await tryCopy(fallbackSource, null, destPath);
        relinka("info", `Fallback copy: ${fallbackSource} -> ${destPath}`);
        return {
          requested: req,
          finalPath: destPath,
          status: "copied",
        };
      } catch (fallbackErr) {
        throw new Error(
          `Primary copy error: ${String(primaryErr)}\nFallback copy error: ${String(
            fallbackErr,
          )}`,
        );
      }
    }
    throw primaryErr;
  }
}

/** Create file from scratch. Provide different strategies or placeholders. */
async function runCreate(
  req: InitFileRequest,
  destPath: string,
): Promise<InitFileResult> {
  const { fileType } = req;
  const { contentCreateMode } = req.options ?? {};

  await createFileFromScratch(destPath, fileType, contentCreateMode);
  relinka("info", `Created file from scratch: ${destPath}`);
  return {
    requested: req,
    finalPath: destPath,
    status: "created",
  };
} 

/** Actually copy a file from base path. */
async function tryCopy(sourceFile: string, srcCopyMode: string | null | undefined, destPath: string) {
  const basePath = srcCopyMode
    ? path.resolve(process.cwd(), srcCopyMode)
    : process.cwd();

  const sourcePath = path.join(basePath, sourceFile);
  if (!(await fs.pathExists(sourcePath))) {
    throw new Error(`Source file not found: ${sourcePath}`);
  }
  await fs.copy(sourcePath, destPath, { overwrite: true });
}



/** If file exists, handle rewrite, skip, attach-index, or prompt. */
async function handleExistingFile(
  destPath: string,
  behaviour: DestFileExistsBehaviour,
): Promise<string | null> {
  switch (behaviour) {
    case "rewrite":
      relinka("warn", `File exists, rewriting: ${destPath}`);
      return destPath;
    case "skip":
      relinka("warn", `File exists, skipping: ${destPath}`);
      return null;
    case "attach-index":
      return attachIndex(destPath);
    case "prompt":
      const choice = await selectPrompt({
        title: `File exists: ${path.basename(destPath)}. How to handle?`,
        options: [
          { label: "Overwrite", value: "overwrite" },
          { label: "Skip", value: "skip" },
          { label: "Attach Index", value: "attachIndex" },
        ],
      });
      if (choice === "skip") return null;
      if (choice === "attachIndex") return attachIndex(destPath);
      return destPath;
  }
}

/** For attach-index, do file.1.ext, file.2.ext, etc. */
async function attachIndex(originalPath: string) {
  const ext = path.extname(originalPath);
  const base = path.basename(originalPath, ext);
  const dir = path.dirname(originalPath);

  let counter = 1;
  let newPath = originalPath;
  while (await fs.pathExists(newPath)) {
    newPath = path.join(dir, `${base}.${counter}${ext}`);
    counter++;
  }
  relinka("info", `Attaching index => ${newPath}`);
  return newPath;
}
