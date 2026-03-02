export class MockSqlClient {
    defaultResult;
    queries = [];
    constructor(defaultResult = { rows: [], rowCount: 1 }) {
        this.defaultResult = defaultResult;
    }
    async query(sql, params) {
        this.queries.push({ sql, params });
        return this.defaultResult;
    }
    async transaction(run) {
        return run(this);
    }
}
export function createLoggerSpy() {
    const infoCalls = [];
    const errorCalls = [];
    return {
        logger: {
            info(message, fields) {
                infoCalls.push({ message, fields });
            },
            error(message, fields) {
                errorCalls.push({ message, fields });
            }
        },
        infoCalls,
        errorCalls
    };
}
