import chalk from 'chalk';

enum LogLevel {
    VERBOSE = 0,
    DEBUG = 1,
    INFO = 2,
    SUCCESS = 3,
    WARN = 4,
    ERROR = 5,
}

interface CallerInfo {
    file?: string;
    line?: number;
    column?: number;
    function?: string;
}

class Logger {
    private prefix: string;
    private logLevel: LogLevel;
    private console: Console;
    private showCaller: boolean;
    level: string = 'INFO';

    constructor(prefix: string = 'CONNECT', LOGLEVEL: string = 'INFO', showCaller: boolean = false) {
        this.prefix = chalk.gray(`[${prefix}]`);
        this.showCaller = showCaller;
        let envLevel;

        // Check environment: browser vs Node.js
        if (typeof window !== 'undefined') {
            // Browser environment
            envLevel = (LOGLEVEL).toUpperCase() as keyof typeof LogLevel;
        } else {
            // Node.js environment - safely access process.env
            const globalProcess = (globalThis as any).process;
            const nodeEnv = globalProcess?.env?.LOG_LEVEL;
            envLevel = (nodeEnv || LOGLEVEL).toUpperCase() as keyof typeof LogLevel;
        }

        this.level = envLevel;
        this.logLevel = LogLevel[envLevel] ?? LogLevel.INFO;
        this.console = globalThis.console;
    }

    private shouldLog(level: LogLevel): boolean {
        return level >= this.logLevel;
    }

    /**
     * Extract caller information from stack trace
     */
    private getCallerInfo(): CallerInfo | null {
        if (!this.showCaller) return null;

        try {
            const stack = new Error().stack;
            if (!stack) return null;

            // Split stack trace into lines
            const lines = stack.split('\n');

            // Skip first 3 lines (Error, getCallerInfo, the log method itself)
            // The 4th line should be the actual caller
            const callerLine = lines[3];
            if (!callerLine) return null;

            // Parse stack trace line
            // Format: "    at ClassName.methodName (file:line:column)"
            // or: "    at file:line:column"
            const match = callerLine.match(/at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?/);

            if (!match) return null;

            const [, functionName, filePath, line, column] = match;

            // Extract just the filename from the full path
            const file = filePath.split('/').pop()?.split('?')[0];

            return {
                file,
                line: parseInt(line, 10),
                column: parseInt(column, 10),
                function: functionName || undefined,
            };
        } catch (error) {
            // If we can't parse the stack, just return null
            return null;
        }
    }

    /**
     * Format caller info for display
     */
    private formatCallerInfo(info: CallerInfo | null): string {
        if (!info) return '';

        const parts: string[] = [];

        if (info.function) {
            parts.push(chalk.cyan(info.function));
        }

        if (info.file) {
            const location = info.line ? `${info.file}:${info.line}` : info.file;
            parts.push(chalk.dim(`(${location})`));
        }

        return parts.length > 0 ? ' ' + parts.join(' ') : '';
    }

    setLevel(level: string): void {
        this.level = level.toUpperCase();
        const envLevel = level.toUpperCase() as keyof typeof LogLevel;
        this.logLevel = LogLevel[envLevel] ?? LogLevel.INFO;
    }

    setShowCaller(show: boolean): void {
        this.showCaller = show;
    }

    // Logging methods with automatic caller detection
    info(...args: any[]): void {
        if (this.shouldLog(LogLevel.INFO)) {
            const caller = this.formatCallerInfo(this.getCallerInfo());
            this.console.info(this.prefix, chalk.blue('INFO') + caller, ...args);
        }
    }

    log(...args: any[]): void {
        this.info(...args); // Alias for info
    }

    verbose(...args: any[]): void {
        if (this.shouldLog(LogLevel.VERBOSE)) {
            const caller = this.formatCallerInfo(this.getCallerInfo());
            this.console.log(this.prefix, chalk.cyan('VERBOSE') + caller, ...args);
        }
    }

    success(...args: any[]): void {
        if (this.shouldLog(LogLevel.SUCCESS)) {
            const caller = this.formatCallerInfo(this.getCallerInfo());
            this.console.debug(this.prefix, chalk.green('SUCCESS') + caller, ...args);
        }
    }

    warn(...args: any[]): void {
        if (this.shouldLog(LogLevel.WARN)) {
            const caller = this.formatCallerInfo(this.getCallerInfo());
            this.console.warn(this.prefix, chalk.yellow('WARN') + caller, ...args);
        }
    }

    error(...args: any[]): void {
        if (this.shouldLog(LogLevel.ERROR)) {
            const caller = this.formatCallerInfo(this.getCallerInfo());
            this.console.error(this.prefix, chalk.red('ERROR') + caller, ...args);
        }
    }

    debug(...args: any[]): void {
        if (this.shouldLog(LogLevel.DEBUG)) {
            const caller = this.formatCallerInfo(this.getCallerInfo());
            this.console.debug(this.prefix, chalk.magenta('DEBUG') + caller, ...args);
        }
    }

    // Rest of the methods remain unchanged
    assert(condition?: boolean, ...data: any[]): void {
        this.console.assert(condition, ...data);
    }

    clear(): void {
        this.console.clear();
    }

    count(label?: string): void {
        this.console.count(label);
    }

    countReset(label?: string): void {
        this.console.countReset(label);
    }

    dir(item?: any, options?: any): void {
        this.console.dir(item, options);
    }

    dirxml(...data: any[]): void {
        this.console.dirxml(...data);
    }

    group(...data: any[]): void {
        this.console.group(...data);
    }

    groupCollapsed(...data: any[]): void {
        this.console.groupCollapsed(...data);
    }

    groupEnd(): void {
        this.console.groupEnd();
    }

    table(tabularData?: any, properties?: string[]): void {
        this.console.table(tabularData, properties);
    }

    time(label?: string): void {
        this.console.time(label);
    }

    timeEnd(label?: string): void {
        this.console.timeEnd(label);
    }

    timeLog(label?: string, ...data: any[]): void {
        this.console.timeLog(label, ...data);
    }

    trace(...data: any[]): void {
        this.console.trace(...data);
    }

    // Note: Console property removed as it's Node.js-specific and not needed

    profile(label?: string): void {
        if ('profile' in this.console) {
            (this.console as any).profile(label);
        }
    }

    profileEnd(label?: string): void {
        if ('profileEnd' in this.console) {
            (this.console as any).profileEnd(label);
        }
    }

    timeStamp(label?: string): void {
        if ('timeStamp' in this.console) {
            (this.console as any).timeStamp(label);
        }
    }
}

// Export Logger class for custom instances
export { Logger };

// Export default instance for general use
export const log = new Logger('CONNECT', 'INFO', false);

// Also export as default
export default log;

declare global {
    interface Console {
        success(...args: any[]): void;
        verbose(...args: any[]): void;
    }
}