import { CreateOptions, createPackageFromFiles } from "@electron/asar"
import { AsyncTaskManager, log } from "builder-util"
import { FileCopier, Filter, MAX_FILE_REQUESTS } from "builder-util/out/fs"
import * as fs from "fs-extra"
import { mkdir, rm, writeFile } from "fs/promises"
import * as path from "path"
import { AsarOptions } from "../options/PlatformSpecificBuildOptions"
import { Packager } from "../packager"
import { PlatformPackager } from "../platformPackager"
import { ResolvedFileSet } from "../util/appFileCopier"
import { detectUnpackedDirs } from "./unpackDetector"
import { homedir, tmpdir } from "os"
import * as asar from "@electron/asar"

/** @internal */
export class AsarPackager {
  private readonly outFile: string
  private readonly fileCopier = new FileCopier()
  private readonly rootForAppFilesWithoutAsar: string
  constructor(private readonly src: string, private readonly destination: string, private readonly options: AsarOptions, private readonly unpackPattern: Filter | null) {
    this.outFile = path.join(this.destination, "app.asar")
    this.rootForAppFilesWithoutAsar = path.join(this.destination, "app")
  }

  async pack(fileSets: Array<ResolvedFileSet>, packager: PlatformPackager<any>) {
    await this.electronAsarPack(fileSets, packager.info)
  }

  private async electronAsarPack(fileSets: Array<ResolvedFileSet>, packager: Packager) {
    const { unpackedDirs, copiedFiles } = await this.detectAndCopy(packager, fileSets)

    const unpack = await Promise.all(
      unpackedDirs.map(async fileOrDir => {
        let p = fileOrDir
        const stats = await fs.lstat(p)
        if (stats.isDirectory()) {
          p = path.join(fileOrDir, "**")
        }
        return path.isAbsolute(fileOrDir) ? p : path.resolve(this.rootForAppFilesWithoutAsar, p)
      })
    )

    const unpackGlob = unpack.length > 1 ? `{${unpack.join(",")}}` : unpack.length === 1 ? unpack[0] : undefined

    const options: CreateOptions = {
      unpack: unpackGlob,
      unpackDir: unpackGlob,
      ordering: this.options.ordering || undefined,
      dot: true,
    }
    await createPackageFromFiles(this.rootForAppFilesWithoutAsar, this.outFile, copiedFiles, undefined, options)
    const tmpDir = path.join(tmpdir(), "electron-builder-test")
    // await mkdir(tmpDir)
    const file = path.join(tmpDir, "temp-asar.asar")
    fs.rmSync(file)
    await createPackageFromFiles(this.rootForAppFilesWithoutAsar, file, copiedFiles, undefined, options)
    const dir = path.resolve(__dirname, "../../test-asar")
    await fs.mkdir(dir)
    asar.extractAll(file, dir)
    log.error({ file, dir }, "temp asar")
    await rm(this.rootForAppFilesWithoutAsar, { recursive: true })
  }

  private async detectAndCopy(packager: Packager, fileSets: ResolvedFileSet[]) {
    const taskManager = new AsyncTaskManager(packager.cancellationToken)
    const unpackedDirs = new Set<string>()
    const copiedFiles = new Set<string>()
    for await (const fileSet of fileSets) {
      if (this.options.smartUnpack !== false) {
        detectUnpackedDirs(fileSet, unpackedDirs, this.rootForAppFilesWithoutAsar)
      }
      for (let i = 0; i < fileSet.files.length; i++) {
        const file = fileSet.files[i]
        const transformedData = fileSet.transformedFiles?.get(i)

        const destFile = path.resolve(this.src, file)
        const destRelative = path.normalize(path.relative(packager.appDir, file))
        // Remove all nesting "../" in the file path, such as for yarn workspaces
        // srcRelative = srcRelative
        //   .split(path.sep)
        //   .filter(p => p !== "..")
        //   .join(path.sep)

        log.warn({ src: this.src, appdir: packager.appDir, srcRelative: destRelative, file, isTransformed: !!transformedData }, "Relative Source")
        const stats = await fs.lstat(destFile).catch(() => fs.lstat(destRelative))
        const shouldUnpack = this.unpackPattern?.(destRelative, stats)
        if (shouldUnpack) {
          log.info({ srcRelative: destRelative }, "unpacking")
          unpackedDirs.add(destRelative)
        }

        const dest = path.resolve(this.rootForAppFilesWithoutAsar, destRelative)
        await mkdir(path.dirname(dest), { recursive: true })

        if (!copiedFiles.has(dest)) {
          taskManager.addTask(this.copyFileOrData(transformedData, file, dest))
          copiedFiles.add(dest)
        }

        // if (taskManager.tasks.length > MAX_FILE_REQUESTS) {
        await taskManager.awaitTasks()
        // }
      }
    }
    await taskManager.awaitTasks()
    return {
      unpackedDirs: Array.from(unpackedDirs),
      copiedFiles: Array.from(copiedFiles),
    }
  }

  private async copyFileOrData(data: string | Buffer | undefined, source: string, destination: string) {
    if (data) {
      return writeFile(destination, data)
    } else {
      return this.fileCopier.copy(source, destination, await fs.lstat(source))
    }
  }
}
