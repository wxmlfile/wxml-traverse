// https://github.com/wxmlfile/wxml-parser/blob/main/docs/ast.md#real-type
import { ElementType, explode } from "./visitors";
import logger from "./logger";

const VISITOR_KEYS = {
  [ElementType.Program]: ["body"],
  [ElementType.WXElement]: ["startTag", "children", "endTag"],
  [ElementType.WXStartTag]: ["attributes"],
  [ElementType.WXAttribute]: ["children"], // children为值的子节点
  [ElementType.WXText]: [],
  [ElementType.WXAttributeInterpolation]: [],
  [ElementType.WXInterpolation]: [],
  [ElementType.WXScript]: [],
  [ElementType.WXEndTag]: [],
  [ElementType.WXComment]: [],
};

let pathCache = new WeakMap();
let scopeCache = new WeakMap();

function debug(msg) {
  logger.trace(msg);
}

debug.enabled = true;

function restoreContext(path, context) {
  if (path.context !== context) {
    path.context = context;
    path.state = context.state;
    path.opts = context.opts;
  }
}

function isTemplate(node) {
  const element = node.startTag;
  const { name } = element || {};
  return name === "template";
}

function isWXAttributeInterpolation(node) {
  return node && node.type === ElementType.WXAttributeInterpolation;
}

function isElementWithWxFor(node) {
  if (node.type !== ElementType.WXElement) return false;
  return hasAttr(node, "wx:for");
}

function isTemplateIdent(node) {
  if (node.type !== ElementType.WXElement) return false;
  if (node.name !== "template") return false;
  return hasAttr(node, "name");
}

function hasAttr(node, key) {
  const element = node.startTag;
  const { attributes = [] } = element || {};
  return attributes.findIndex((attr) => attr.key === key) > -1;
}

function shallowEqual(actual, expected) {
  const keys = Object.keys(expected);

  for (const key of keys) {
    if (actual[key] !== expected[key]) {
      return false;
    }
  }

  return true;
}

enum WXML_SCOPE_VAR_TYPE {
  FOR_ITEM = 1,
  FOR_INDEX = 2,
}
/**
 * 三条规则：
 * - 如果是template的定义，则产生隔离的独立作用域
 * - 如果是wx:for，则加入新的本地变量
 * - template的定义下可以使用<include标签
 *
 * 在wx:for和template name共同的作用下面，可能出现混用情况
 */
const collectorVisitor = explode({
  /**
   * @param {NodePath} path
   * @param {*} state
   */
  WXElement(path, state) {
    const attributes = path.node.startTag.attributes || [];
    const vars: { [varName: string]: { type: WXML_SCOPE_VAR_TYPE } } = {};
    let hasForItemDecl = false;
    let hasForIndexDecl = false;
    let forItemVarName;
    let forIndexVarName;
    attributes.forEach((attr) => {
      const { key, children, value } = attr;
      switch (key) {
        case "wx:for":
          vars["item"] = {
            type: WXML_SCOPE_VAR_TYPE.FOR_ITEM,
          };
          vars["index"] = {
            type: WXML_SCOPE_VAR_TYPE.FOR_INDEX,
          };
          break;
        case "wx:for-item":
          hasForItemDecl = true;
          if (children.length) {
            logger.error(
              `【wxml】${path.getPathLocation()} wx:for-item属性必须为string`
            );
          }
          forItemVarName = value;
          vars[value] = {
            type: WXML_SCOPE_VAR_TYPE.FOR_ITEM,
          };
          break;
        case "wx:for-index":
          hasForIndexDecl = true;
          if (children.length) {
            logger.error(
              `【wxml】${path.getPathLocation()} wx:for-index属性必须为string`
            );
          }
          forIndexVarName = value;
          vars[value] = {
            type: WXML_SCOPE_VAR_TYPE.FOR_INDEX,
          };
          break;
      }
    });
    if (hasForItemDecl && forItemVarName !== "item") delete vars.item;
    if (hasForIndexDecl && forIndexVarName !== "index") delete vars.index;
    Object.keys(vars).forEach((key) => {
      path.scope.registerBinding(key, vars[key]);
    });
    if (isTemplateIdent(path.node)) {
      path.scope.addGlobal(path);
    }
  },
});

let uid = 0;
class Scope {
  uid: number;
  block: any;
  path: any;
  labels: Map<any, any>;
  inited: boolean;
  bindings: any;
  globals: any;
  uids: any;
  data: any;
  crawling: boolean;
  isolatedNamespace: boolean;
  key: string;
  /**
   *
   * @param {NodePath} path
   * @returns
   */
  constructor(path) {
    const { node } = path;
    const cached = scopeCache.get(node);
    // Sometimes, a scopable path is placed higher in the AST tree.
    // In these cases, have to create a new Scope.
    if (cached?.path === path) {
      return cached;
    }
    scopeCache.set(node, this);

    this.uid = uid++;

    this.block = node;
    this.path = path;

    this.labels = new Map();
    this.inited = false;
  }
  init() {
    // 将内部使用的变量和方法收集
    if (!this.inited) {
      this.inited = true;
      this.crawl();
    }
  }
  // 爬格子
  crawl() {
    // 更新衍生数据
    // 收集wx:for wx:for-item wx:for-index中声明的临时变量
    /**
     * @type {NodePath}
     */
    const path = this.path;
    // FIXME: 难度较大，暂时不收集所有变量的使用
    // this.references = Object.create(null);
    this.bindings = Object.create(null);
    this.globals = Object.create(null);
    this.uids = Object.create(null);
    this.data = Object.create(null);

    // FIXME: 注释掉，避免body的最外层存在parent但不存在parentPath
    // const programParent = this.getProgramParent();
    // if (programParent.crawling) return;
    // this.crawling = true;

    const state = {
      // references: [],
      // assignments: [],
      // assignments: [],
      // 记录template的定义
      templateIdents: [],
    };
    // path是父级的wx:for, wx:for-item, wx:for-index，collectorVisitor中只会访问子元素
    const typeVisitors = collectorVisitor[path.type];
    if (typeVisitors) {
      for (const visit of typeVisitors.enter) {
        visit(path, state);
      }
    }
    path.traverse(collectorVisitor, state);
    this.crawling = false;
  }
  getProgramParent() {
    let scope = this;
    do {
      if (scope.path.isProgram()) {
        return scope;
      }
    } while ((scope = scope.getParent()));
    throw new Error("Couldn't find a Program");
  }
  getParent() {
    let parent;
    let path = this.path;
    do {
      // Skip method scope if coming from inside computed key or decorator expression
      // const shouldSkip = path.key === 'key' || path.listKey === 'decorators';
      path = path.parentPath;
      // if (shouldSkip && path.isMethod()) path = path.parentPath;
      if (path && path.isScope()) parent = path;
    } while (path && !parent);

    return parent?.scope;
  }
  /**
   * TODO: 第二个参数应该是path，还是在wx:for情况下局部变量的变量名?
   * - template可以认为是一个独立的wxml
   * - template中可以使用<include
   * - template中的事件是根据其所在的页面和组件，直接透传，不用显式传递的
   * @param {*} varKey 生成的局部变量声明的种类标识，如forItemVar，forIndexVar
   * @param {*} varName 生成的局部变量的名称，默认为item index
   */
  registerBinding(varKey, varName) {
    // this.forVars = forVars;
    this.bindings[varKey] = varName;
  }
  addGlobal(path) {
    this.isolatedNamespace = true;
    this.globals[path.node.name] = path;
  }
  /**
   * 1. 对于收集的data, method, property的全局命名空间
   * 2. 对于template，在component和page命名空间下
   *   - method透传
   *   - data和property
   *     - 通过实例化处compress的结果来压，实例化处的data的key也压，如果是存在...data类型，则只能放弃压template
   *     - 仅压缩内部使用的变量名，那么如果外实例化处有...data的数据传递，则依旧不可压
   * 3. 对于wx:for生成的局部变量，forItemVar和forIndexVar，则可以直接根据其子元素，全部压缩
   *   - 如果子ele中有<include, <template is=，则递归上述三条准则重复执行
   *   - 对于由外到内存在的重复命名的forItemVar和forIndex，则根据Scope由内到外，来识别(实际如果压缩变量名全局唯一，则无需考虑识别问题)
   * @returns
   */
  getAllBindings() {
    const ids = Object.create(null);

    let scope = this;
    // todo: 如果是templateIdent，则无需继续向上重复
    do {
      for (const key of Object.keys(scope.bindings)) {
        if (key in ids === false) {
          ids[key] = scope.bindings[key];
        }
      }
      scope = scope.parent();
    } while (scope && !scope.isolatedNamespace);

    return ids;
  }
  getOwnBinding(name) {
    return this.bindings[name];
  }
  getParentBinding() {
    const ids = Object.create(null);

    let scope = this;
    // todo: 如果是templateIdent，则无需继续向上重复
    do {
      for (const key of Object.keys(scope.bindings)) {
        if (key in ids === false && key in this.bindings === false) {
          ids[key] = scope.bindings[key];
        }
      }
      scope = scope.parent();
    } while (scope && !scope.isolatedNamespace);

    return ids;
  }
  parent() {
    return this.path.findParent((parent) => !!parent.scope)?.scope;
  }
}

type ASTNode = {
  type: ElementType;
} & {
  [key: string]: ASTNode | null;
};

class NodePath {
  contexts = [];
  state = null;
  opts = null;
  _traverseFlags = 0;
  skipKeys = null;
  parentPath = null;
  container = null;
  listKey = "";
  key: "";
  node: ASTNode;
  type = null;
  parent: any;
  hub: any;
  data: null;
  context: null;
  scope: Scope;
  inList: any;
  shouldSkip: boolean;
  shouldStop: any;
  removed: any;
  constructor(hub, parent) {
    this.parent = parent;
    this.hub = hub;
    this.data = null;

    this.context = null;
    this.scope = null;
  }
  static get({
    hub,
    parentPath,
    parent,
    container,
    listKey,
    key,
  }: {
    hub?: string;
    parentPath: NodePath;
    parent: ASTNode;
    container: ASTNode;
    listKey?: string;
    key: string | number;
  }) {
    if (!hub && parentPath) {
      hub = parentPath.hub;
    }

    if (!parent) {
      throw new Error("To get a node path the parent needs to exist");
    }

    const targetNode = container[key];
    let paths = pathCache.get(parent);
    if (!paths) {
      paths = new Map();
      pathCache.set(parent, paths);
    }
    let path = paths.get(targetNode);
    if (!path) {
      path = new NodePath(hub, parent);
      if (targetNode) paths.set(targetNode, path);
    }
    path.setup(parentPath, container, listKey, key);

    return path;
  }
  getPathLocation() {
    const parts: string[] = [];
    let path: NodePath | null = this;
    do {
      let key: string = path.key;
      if (path.inList) key = `${path.listKey}[${key}]`;
      parts.unshift(key);
    } while ((path = path.parentPath));
    return parts.join(".");
  }
  setup(parentPath, container, listKey, key) {
    this.listKey = listKey;
    this.container = container;

    this.parentPath = parentPath || this.parentPath;
    this.setKey(key);
  }
  setKey(key) {
    this.key = key;
    this.node = this.container[this.key];
    this.type = this.node?.type;
  }
  visit() {
    if (!this.node) {
      return false;
    }

    if (this.isDenylisted()) {
      return false;
    }

    if (this.opts.shouldSkip && this.opts.shouldSkip(this)) {
      return false;
    }

    const currentContext = this.context;
    // Note: We need to check "this.shouldSkip" first because
    // another visitor can set it to true. Usually .shouldSkip is false
    // before calling the enter visitor, but it can be true in case of
    // a requeued node (e.g. by .replaceWith()) that is then marked
    // with .skip().
    if (this.shouldSkip || this.call("enter")) {
      this.debug("Skip...");
      return this.shouldStop;
    }
    restoreContext(this, currentContext);

    this.debug("Recursing into...");
    this.shouldStop = traverseNode(
      this.node,
      this.opts,
      this.scope,
      this.state,
      this,
      this.skipKeys
    );

    restoreContext(this, currentContext);

    this.call("exit");

    return this.shouldStop;
  }
  call(key) {
    const opts = this.opts;

    this.debug(key);

    if (this.node) {
      if (this._call(opts[key])) return true;
    }

    if (this.node) {
      return this._call(opts[this.node.type] && opts[this.node.type][key]);
    }

    return false;
  }
  _call(fns) {
    if (!fns) return false;

    for (const fn of fns) {
      if (!fn) continue;

      const node = this.node;
      if (!node) return true;

      const ret = fn.call(this.state, this, this.state);
      if (ret && typeof ret === "object" && typeof ret.then === "function") {
        throw new Error(
          `You appear to be using a plugin with an async traversal visitor, ` +
            `which your current version of Babel does not support. ` +
            `If you're using a published plugin, you may need to upgrade ` +
            `your @babel/core version.`
        );
      }
      if (ret) {
        throw new Error(`Unexpected return value from visitor method ${fn}`);
      }

      // node has been replaced, it will have been requeued
      if (this.node !== node) return true;

      // this.shouldSkip || this.shouldStop || this.removed
      if (this._traverseFlags > 0) return true;
    }

    return false;
  }
  debug(message) {
    if (!debug.enabled) return;
    debug(`${this.getPathLocation()} ${this.type}: ${message}`);
  }
  isDenylisted() {
    const denylist = this.opts.denylist ?? this.opts.blacklist;
    return denylist && denylist.indexOf(this.node.type) > -1;
  }
  resync() {
    if (this.removed) return;

    this._resyncParent();
    this._resyncList();
    this._resyncKey();
  }
  _resyncParent() {
    if (this.parentPath) {
      this.parent = this.parentPath.node;
    }
  }
  _resyncList() {
    if (!this.parent || !this.inList) return;

    const newContainer = this.parent[this.listKey];
    if (this.container === newContainer) return;

    // container is out of sync. this is likely the result of it being reassigned
    this.container = newContainer || null;
  }
  _resyncKey() {
    if (!this.container) return;

    if (this.node === this.container[this.key]) {
      return;
    }

    // grrr, path key is out of sync. this is likely due to a modification to the AST
    // not done through our path APIs

    if (Array.isArray(this.container)) {
      for (let i = 0; i < this.container.length; i++) {
        if (this.container[i] === this.node) {
          return this.setKey(i);
        }
      }
    } else {
      for (const key of Object.keys(this.container)) {
        if (this.container[key] === this.node) {
          return this.setKey(key);
        }
      }
    }

    // ¯\_(ツ)_/¯ who knows where it's gone lol
    this.key = null;
  }
  pushContext(context) {
    this.contexts.push(context);
    this.setContext(context);
  }
  setContext(context) {
    if (this.skipKeys != null) {
      this.skipKeys = {};
    }
    // this.shouldSkip = false; this.shouldStop = false; this.removed = false;
    this._traverseFlags = 0;

    if (context) {
      this.context = context;
      this.state = context.state;
      this.opts = context.opts;
    }

    this.setScope();

    return this;
  }
  setScope() {
    if (this.opts && this.opts.noScope) return;

    let path = this.parentPath;

    // // Skip method scope if is computed method key or decorator expression
    // if ((this.key === 'key' || this.listKey === 'decorators') && path.isMethod()) {
    //     path = path.parentPath;
    // }

    let target;
    while (path && !target) {
      if (path.opts && path.opts.noScope) return;

      target = path.scope;
      path = path.parentPath;
    }

    this.scope = this.getScope(target);
    if (this.scope) this.scope.init();
  }
  /**
   *
   * @param {Scope} scope
   * @returns {Scope}
   */
  getScope(scope) {
    return this.isScope() ? new Scope(this) : scope;
  }
  // wx:for的使用，和template标签且有name属性的模板定义
  isScope() {
    const node = this.node;
    return (
      isElementWithWxFor(node) || isTemplateIdent(node) || this.isProgram(node)
    );
    // const node = this.node;
    // // If a BlockStatement is an immediate descendent of a Function/CatchClause, it must be in the body.
    // // Hence we skipped the parentKey === "params" check
    // if (isBlockStatement(node) && (isFunction(parent) || isCatchClause(parent))) {
    //     return false;
    // }

    // // If a Pattern is an immediate descendent of a Function/CatchClause, it must be in the params.
    // // Hence we skipped the parentKey === "params" check
    // if (isPattern(node) && (isFunction(parent) || isCatchClause(parent))) {
    //     return true;
    // }

    // return isScopable(node);
  }
  findParent(
    callback // (path: NodePath) => boolean
  ) {
    let path = this;
    while ((path = path.parentPath)) {
      if (callback(path)) return path;
    }
    return null;
  }
  // 暂时无用
  isProgram(opts) {
    const node = this.node;
    if (!node) return false;

    const nodeType = node.type;
    if (nodeType === "Program") {
      if (typeof opts === "undefined") {
        return true;
      } else {
        return shallowEqual(node, opts);
      }
    }

    return false;
  }
  popContext() {
    this.contexts.pop();
    if (this.contexts.length > 0) {
      this.setContext(this.contexts[this.contexts.length - 1]);
    } else {
      this.setContext(undefined);
    }
  }
  traverse(visitor, state) {
    traverseAsBabel(this.node, visitor, this.scope, state, this);
  }
  get(key, context = true) {
    if (context === true) context = this.context;
    const parts = key.split(".");
    if (parts.length === 1) {
      // "foo"
      return this._getKey(key, context);
    } else {
      // "foo.bar"
      return this._getPattern(parts, context);
    }
  }
  _getKey(key: string, context: boolean) {
    const node = this.node;
    const container = node[key];
    if (Array.isArray(container)) {
      // requested a container so give them all the paths
      return container.map((_, i) => {
        return NodePath.get({
          listKey: key,
          parentPath: this,
          parent: node,
          container: container,
          key: i,
        }).setContext(context);
      });
    } else {
      return NodePath.get({
        parentPath: this,
        parent: node,
        container: node,
        key: key,
      }).setContext(context);
    }
  }
  _getPattern(parts, context) {
    let path = this;
    for (const part of parts) {
      if (part === ".") {
        path = path.parentPath;
      } else {
        if (Array.isArray(path)) {
          path = path[part];
        } else {
          path = path.get(part, context);
        }
      }
    }
    return path;
  }
  isTop() {
    return !this.parentPath;
  }
}

class TraversalContext {
  scope: any;
  opts: any;
  state: any;
  parentPath: any;
  queue: any;
  priorityQueue: any[];
  constructor(scope, opts, state, parentPath) {
    this.scope = scope;
    this.opts = opts;
    this.state = state;
    this.parentPath = parentPath;
  }
  visit(node, key) {
    const nodes = node[key]; // t.Node | t.Node[] | null;
    if (!nodes) return false;

    if (Array.isArray(nodes)) {
      return this.visitMultiple(nodes, node, key);
    } else {
      return this.visitSingle(node, key);
    }
  }
  visitMultiple(container, parent, listKey) {
    if (container.length === 0) return false;

    const queue = [];

    // build up initial queue
    for (let key = 0; key < container.length; key++) {
      const node = container[key];
      if (node && this.shouldVisit(node)) {
        queue.push(this.create(parent, container, key, listKey));
      }
    }

    return this.visitQueue(queue);
  }
  visitSingle(node, key) {
    if (this.shouldVisit(node[key])) {
      return this.visitQueue([this.create(node, node, key)]);
    } else {
      return false;
    }
  }
  shouldVisit(node) {
    const opts = this.opts;
    if (opts.enter || opts.exit) return true;

    // check if we have a visitor for this node
    if (opts[node.type]) return true;

    // check if we're going to traverse into this node
    const keys = VISITOR_KEYS[node.type];
    if (!keys?.length) return false;

    // we need to traverse into this node so ensure that it has children to traverse into!
    for (const key of keys) {
      if (node[key]) {
        return true;
      }
    }

    return false;
  }
  create(
    node: ASTNode,
    container: ASTNode,
    key: string | number,
    listKey?: string
  ) {
    // We don't need to `.setContext()` here, since `.visitQueue()` already
    // calls `.pushContext`.
    return NodePath.get({
      parentPath: this.parentPath,
      parent: node,
      container,
      key: key,
      listKey,
    });
  }
  /**
   * @param {NodePath[]} queue
   * @returns
   */
  visitQueue(queue) {
    // set queue
    this.queue = queue;
    this.priorityQueue = [];

    const visited = new WeakSet();
    let stop = false;

    // visit the queue
    for (const path of queue) {
      path.resync();

      if (
        path.contexts.length === 0 ||
        path.contexts[path.contexts.length - 1] !== this
      ) {
        // The context might already have been pushed when this path was inserted and queued.
        // If we always re-pushed here, we could get duplicates and risk leaving contexts
        // on the stack after the traversal has completed, which could break things.
        path.pushContext(this);
      }

      // this path no longer belongs to the tree
      if (path.key === null) continue;

      // ensure we don't visit the same node twice
      const { node } = path;
      if (visited.has(node)) continue;
      if (node) visited.add(node);

      if (path.visit()) {
        stop = true;
        break;
      }

      if (this.priorityQueue.length) {
        stop = this.visitQueue(this.priorityQueue);
        this.priorityQueue = [];
        this.queue = queue;
        if (stop) break;
      }
    }

    // clear queue
    for (const path of queue) {
      path.popContext();
    }

    // clear queue
    this.queue = null;

    return stop;
  }
}

let DEBUG_SETTING_FLAG = false;
function traverseNode(
  node: ASTNode,
  opts,
  scope: Scope,
  state,
  parentPath: NodePath,
  skipKeys?: string[],
  debugEnable = false,
) {
  if (!DEBUG_SETTING_FLAG) {
    debug.enabled = debugEnable;
    debugEnable = true;
  }
  const keys = VISITOR_KEYS[node.type];
  if (!keys) return false;
  const context = new TraversalContext(scope, opts, state, parentPath);
  for (const key of keys) {
    if (skipKeys && skipKeys[key]) continue;
    if (context.visit(node, key)) {
      return true;
    }
  }

  return false;
}

// referred from babel
function traverseAsBabel(parent, opts, scope, state, parentPath) {
  if (!parent) return;
  if (!VISITOR_KEYS[parent.type]) {
    return;
  }
  if (!opts.noScope && !scope) {
    if (parent.type !== "Program" && parent.type !== "File") {
      throw new Error(
        "You must pass a scope and parentPath unless traversing a Program/File. " +
          `Instead of that you tried to traverse a ${parent.type} node without ` +
          "passing scope and parentPath."
      );
    }
  }
  explode(opts);
  traverseNode(parent, opts, scope, state, parentPath);
}

const types = {
  isTemplate,
  isElementWithWxFor,
  isTemplateIdent,
  isWXAttributeInterpolation,
};

export { traverseAsBabel as traverse, types, NodePath };
