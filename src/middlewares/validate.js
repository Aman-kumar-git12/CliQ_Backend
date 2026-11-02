// validate({ body, query }) checks the request against zod schemas (src/validation/schemas.js).
// A bad request gets 400 { message, errors: [{ path, message }] }; a good body is replaced by the
// parsed one, so controllers get trimmed, lower-cased and defaulted values.
const docs = require("../docs/registry");

const validationError = (issues) => {
    const errors = issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
    const error = new Error(errors[0]?.message || "Invalid request");
    error.status = 400;
    error.code = "VALIDATION_ERROR";
    error.details = errors;
    return error;
};

const validate = (schemas) => {
    const middleware = (req, res, next) => {
        if (schemas.body) {
            const result = schemas.body.safeParse(req.body ?? {});
            if (!result.success) return next(validationError(result.error.issues));
            req.body = result.data;
        }
        if (schemas.query) {
            const result = schemas.query.safeParse(req.query);
            if (!result.success) return next(validationError(result.error.issues));
        }
        next();
    };
    // Lets the API docs find the schemas attached to each route
    docs.tag(middleware, schemas);
    return middleware;
};

module.exports = { validate };
