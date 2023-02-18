enum ElementType {
    Program = 'Program',
    WXElement = 'WXElement',
    WXScript = 'WXScript',
    WXText = 'WXText',
    WXAttributeInterpolation = 'WXAttributeInterpolation',
    WXInterpolation = 'WXInterpolation',
    WXComment = 'WXComment',
    WXAttribute = 'WXAttribute',
    WXStartTag = 'WXStartTag',
    WXEndTag = 'WXEndTag',
};

function verify(visitor) {
    if (visitor._verified) return;

    if (typeof visitor === 'function') {
        throw new Error(
            'You passed `traverse()` a function when it expected a visitor object, ' +
                "are you sure you didn't mean `{ enter: Function }`?"
        );
    }

    for (const nodeType of Object.keys(visitor)) {
        if (nodeType === 'enter' || nodeType === 'exit') {
            validateVisitorMethods(nodeType, visitor[nodeType]);
        }

        if (shouldIgnoreKey(nodeType)) continue;

        if (!(nodeType in ElementType)) {
            throw new Error(`You gave us a visitor for the node type ${nodeType} but it's not a valid type`);
        }

        const visitors = visitor[nodeType];
        if (typeof visitors === 'object') {
            for (const visitorKey of Object.keys(visitors)) {
                if (visitorKey === 'enter' || visitorKey === 'exit') {
                    // verify that it just contains functions
                    validateVisitorMethods(`${nodeType}.${visitorKey}`, visitors[visitorKey]);
                } else {
                    throw new Error(
                        'You passed `traverse()` a visitor object with the property ' +
                            `${nodeType} that has the invalid property ${visitorKey}`
                    );
                }
            }
        }
    }

    visitor._verified = true;
}

function explode(visitor) {
    if (visitor._exploded) return visitor;
    visitor._exploded = true;

    // normalise pipes
    for (const nodeType of Object.keys(visitor)) {
        if (shouldIgnoreKey(nodeType)) continue;

        const parts = nodeType.split('|');
        if (parts.length === 1) continue;

        const fns = visitor[nodeType];
        delete visitor[nodeType];

        for (const part of parts) {
            visitor[part] = fns;
        }
    }

    // verify data structure
    verify(visitor);

    // make sure there's no __esModule type since this is because we're using loose mode
    // and it sets __esModule to be enumerable on all modules :(
    delete visitor.__esModule;

    // ensure visitors are objects
    ensureEntranceObjects(visitor);

    // ensure enter/exit callbacks are arrays
    ensureCallbackArrays(visitor);

    // add type wrappers
    // for (const nodeType of Object.keys(visitor)) {
    //     if (shouldIgnoreKey(nodeType)) continue;

    //     // @ts-expect-error Fixme: nodeType could index virtualTypes
    //     const wrapper = virtualTypes[nodeType];
    //     if (!wrapper) continue;

    //     // wrap all the functions
    //     const fns = visitor[nodeType];
    //     for (const type of Object.keys(fns)) {
    //         // @ts-expect-error manipulating visitors
    //         fns[type] = wrapCheck(wrapper, fns[type]);
    //     }

    //     // clear it from the visitor
    //     delete visitor[nodeType];

    //     if (wrapper.types) {
    //         for (const type of wrapper.types) {
    //             // merge the visitor if necessary or just put it back in
    //             if (visitor[type]) {
    //                 mergePair(visitor[type], fns);
    //             } else {
    //                 visitor[type] = fns;
    //             }
    //         }
    //     } else {
    //         mergePair(visitor, fns);
    //     }
    // }

    // add aliases
    // for (const nodeType of Object.keys(visitor)) {
    //     if (shouldIgnoreKey(nodeType)) continue;

    //     const fns = visitor[nodeType];

    //     // let aliases = FLIPPED_ALIAS_KEYS[nodeType];

    //     // const deprecatedKey = DEPRECATED_KEYS[nodeType];
    //     // if (deprecatedKey) {
    //     //     console.trace(`Visitor defined for ${nodeType} but it has been renamed to ${deprecatedKey}`);
    //     //     aliases = [deprecatedKey];
    //     // }

    //     if (!aliases) continue;

    //     // clear it from the visitor
    //     delete visitor[nodeType];

    //     for (const alias of aliases) {
    //         const existing = visitor[alias];
    //         if (existing) {
    //             mergePair(existing, fns);
    //         } else {
    //             visitor[alias] = { ...fns };
    //         }
    //     }
    // }

    for (const nodeType of Object.keys(visitor)) {
        if (shouldIgnoreKey(nodeType)) continue;

        ensureCallbackArrays(
            visitor[nodeType]
        );
    }

    return visitor;
};

function ensureCallbackArrays(obj) {
    if (obj.enter && !Array.isArray(obj.enter)) obj.enter = [obj.enter];
    if (obj.exit && !Array.isArray(obj.exit)) obj.exit = [obj.exit];
}

function ensureEntranceObjects(obj) {
    for (const key of Object.keys(obj)) {
        if (shouldIgnoreKey(key)) continue;

        const fns = obj[key];
        if (typeof fns === 'function') {
            obj[key] = { enter: fns };
        }
    }
}

function shouldIgnoreKey(key) {
    // internal/hidden key
    if (key[0] === '_') return true;

    // ignore function keys
    if (key === 'enter' || key === 'exit' || key === 'shouldSkip') return true;

    // ignore other options
    if (
        key === 'denylist' ||
        key === 'noScope' ||
        key === 'skipKeys' ||
        // TODO: Remove in Babel 8
        key === 'blacklist'
    ) {
        return true;
    }

    return false;
}

function validateVisitorMethods(path, val) {
    const fns = [].concat(val);
    for (const fn of fns) {
        if (typeof fn !== 'function') {
            throw new TypeError(`Non-function found defined in ${path} with type ${typeof fn}`);
        }
    }
}

export {
    ElementType,
    explode,
    verify
}
