import esbuild from 'esbuild';
import { getConfig } from '../utilities/getConfig';
import p from 'node:path';
import { glob } from 'glob';
import { configDotenv } from 'dotenv';
import assert from 'node:assert';
import defaultEsbuild from '../utilities/defaultEsbuildConfig';
import { require } from '../utilities/require';
import { pathExists, pathExistsSync } from 'find-up';
import { mkdir, writeFile } from 'fs/promises';
import * as Preprocessor from '../utilities/preprocessor';
import { bold, magentaBright } from 'colorette';
import { parseTsConfig } from '../utilities/parseTsconfig';
import { execa, type ExecaChildProcess } from 'execa';
import { InvalidArgumentError } from 'commander';

const VALID_EXTENSIONS = ['.ts', '.js' ];

type BuildOptions = {
    /**
     * Define __VERSION__
     * This option is a quick switch to defining the __VERSION__ constant which will be a string of the version provided in
     * cwd's package.json
     */
    defineVersion?: boolean;
    /**
     * default = esm
     */
    format?: 'cjs' | 'esm';
    /**
     * https://esbuild.github.io/api/#drop-labels
     **/
    dropLabels?: string[];
    /**
     * https://esbuild.github.io/api/#define
     **/
    define?: Record<string, string>;

    tsconfig?: string;
    /**
     * default = 'development'
     */
    mode: 'production' | 'development';
    /**
     * will search for env file. If none exists,
     * default to .env.
     */
    env?: string;
    /**
     * flag: default false
     */
    sourcemap?: boolean;

    watch?: {
        /**
         * command to run.
         * defaults to your package
         * manager's start command.
         */
        command?: string;
    }
    
};

const CommandHandlerPlugin = (buildConfig: Partial<BuildOptions>, ambientFilePath: string, sernTsConfigPath: string) => {
    return {
        name: "commandHandler",
        setup(build) {

            const options = build.initialOptions
            const defVersion = () => JSON.stringify(require(p.resolve('package.json')).version);
            // should fix a type error
            options.define = { 
                ...(buildConfig.define ?? {}),
                __DEV__: `${buildConfig.mode === 'development'}`,
                __PROD__: `${buildConfig.mode === 'production'}`,
                __VERSION__: `${buildConfig.defineVersion ? `${defVersion()}` : 'undefined'}`
            }
            Preprocessor.writeTsConfig(buildConfig.format!, sernTsConfigPath, writeFile);
            Preprocessor.writeAmbientFile(ambientFilePath, options.define!, writeFile);
            
        }
    } as esbuild.Plugin
}
const CommandOnEndPlugin = (watching: boolean, watchCommand?: string) => {
    // for some reason it runs the command twice on first build
    let isFirstBuild = true;
    let currentProcess: ExecaChildProcess | null = null;
    let restartTimeout: NodeJS.Timeout | null = null;
    return {
        name: 'watchRunCommand',
        setup(build: esbuild.PluginBuild) {
            build.onEnd(async (result) => {
                if (!watching || result.errors.length !== 0) return;
                if (isFirstBuild === true) {
                    isFirstBuild = false;
                    return;
                }
                if (watchCommand === '') {
                    console.log('[watch] no command provided, skipping');
                    return;
                }

                if (currentProcess) {
                    console.log('[watch] stopping previous process...');
                    currentProcess.cancel()
                    currentProcess = null;
                }

                const cmd = watchCommand || (() => {
                    if (pathExistsSync('package-lock.json')) return 'npm start';
                    if (pathExistsSync('yarn.lock')) return 'yarn start';
                    if (pathExistsSync('pnpm-lock.yaml')) return 'pnpm start';
                    if (pathExistsSync('bun.lockb')) return 'bun start';
                    if (pathExistsSync('bun.lock')) return 'bun start';

                    throw new Error('[watch] default package manager start command not found');
                })();

                // Clear any pending restart
                if (restartTimeout) clearTimeout(restartTimeout);

                console.log('[watch] debouncing command for 1.5 seconds...');
                
                // Set new debounced timeout
                restartTimeout = setTimeout(() => {
                    console.log(`[watch] running command: ${cmd}`);
                    currentProcess = execa(cmd, { stdio: 'inherit', shell: true });
                    currentProcess.catch(error => {
                        if (error.isCanceled) return;
                        console.error(`[watch] command execution error: ${error.message}`);
                    });
                }, 1500);
            });
        }
    } as esbuild.Plugin;
};
const resolveBuildConfig = (path: string | undefined, language: string) => {
    if (language === 'javascript') {
        return path ?? 'jsconfig.json'
    }
    return path ?? 'tsconfig.json'
}

export async function build(options: Record<string, any>) {
    //console.log(options)
    if (!options.supressWarnings) {
        console.info(`${magentaBright('EXPERIMENTAL')}: This API has not been stabilized. add -W or --suppress-warnings flag to suppress`);
    }
    // if watch was not enabled and watchCommand is present
    if(!options.watch && options.watchCommand) {
        throw new InvalidArgumentError("enable watch to use --watch-command")
    }
    
    const sernConfig = await getConfig();
    let buildConfig: BuildOptions; 
    const buildConfigPath = p.resolve(options.project ?? 'sern.build.js');

    const defaultBuildConfig = {
        defineVersion: true,
        format: options.format ?? 'esm',
        mode: options.mode ?? 'development',
        dropLabels: [],
        sourcemap: options.sourceMaps,
        tsconfig: resolveBuildConfig(options.tsconfig, sernConfig.language),
        env: options.env ?? '.env',
        include: [],
        watch: {
            command: options.watchCommand
        }
    };

    // merging configuration with sern.build.js, if exists buildConfigPath 
    if (pathExistsSync(buildConfigPath)) {
        let fileConfig; 
        try { fileConfig=await import('file:///' + buildConfigPath).then(r=>r.default) }
        catch(e) { 
            console.error("Could not find buildConfigPath")
            throw e;
        }
        //throwable, buildConfigPath may not exist, todo, merge
        buildConfig = { ...defaultBuildConfig, ...fileConfig };
    } else {
        buildConfig = defaultBuildConfig;
        console.log('No build config found, defaulting');
    }

    configDotenv({ path: buildConfig.env  });
    
    if (process.env.NODE_ENV) {
        buildConfig.mode = process.env.NODE_ENV as 'production' | 'development';
        console.log(magentaBright('NODE_ENV:'), 'Found NODE_ENV variable, setting `mode` to this.');
    }
    assert(buildConfig.mode === 'development' || buildConfig.mode === 'production', 'NODE_ENV is not `production` or `development`');
    try {
        let config = await parseTsConfig(buildConfig.tsconfig!);
        config?.extends && console.warn("Extend the generated tsconfig")
    } catch(e) {
         console.error("no tsconfig / jsconfig found");
         console.error(`Please create a ${sernConfig.language === 'javascript' ? 'jsconfig.json' : 'tsconfig.json' }`);
         console.error('It should have at least extend the generated one sern makes.\n \
                        { "extends": "./.sern/tsconfig.json" }');
         throw e;
    }

    console.log(bold('Building with:'));
    console.log(' ', magentaBright('defineVersion'), buildConfig.defineVersion);
    console.log(' ', magentaBright('format'), buildConfig.format);
    console.log(' ', magentaBright('mode'), buildConfig.mode);
    console.log(' ', magentaBright('tsconfig'), buildConfig.tsconfig);
    console.log(' ', magentaBright('env'), buildConfig.env);
    console.log(' ', magentaBright('sourceMaps'), buildConfig.sourcemap);

    const sernDir = p.resolve('.sern'),
          [ambientFilePath, sernTsConfigPath, genDir] = // resolves the file paths in the .sern dir
          ['ambient.d.ts', 'tsconfig.json', 'generated'].map(f => p.resolve(sernDir, f));

    if (!(await pathExists(genDir))) {
        console.log('Making .sern/generated dir, does not exist');
        await mkdir(genDir, { recursive: true });
    }
    
    const entryPoints = await glob(`src/**/*{${VALID_EXTENSIONS.join(',')}}`,{ 
         ignore: {
            ignored: (p) => p.name.endsWith('.d.ts'),
        }
    });
    //https://esbuild.github.io/content-types/#tsconfig-json
    const ctx = await esbuild.context({
        entryPoints,
        plugins: [
            CommandHandlerPlugin(buildConfig, ambientFilePath, sernTsConfigPath),
            CommandOnEndPlugin(options.watch, buildConfig.watch?.command)
        ],
        sourcemap: buildConfig.sourcemap,
        ...defaultEsbuild(buildConfig.format!, buildConfig.tsconfig),
        dropLabels: [buildConfig.mode === 'production' ? '__DEV__' : '__PROD__', ...buildConfig.dropLabels!],
    });

    await ctx.rebuild()
    if (options.watch) {
        await ctx.watch()
    } else {
        await ctx.dispose()
    }
}
