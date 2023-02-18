const { traverse, types } = require("../lib/traverse");
const { default: logger } = require("../lib/logger");

function unsafeIsEventAttr(attrKey) {
  return (
    attrKey.startsWith("bind") ||
    attrKey.startsWith("catch") ||
    attrKey.startsWith("catch") ||
    attrKey.startsWith("capture-bind") ||
    attrKey.startsWith("capture-catch") ||
    attrKey.startsWith("mut-bind") ||
    attrKey.startsWith("mut-catch")
  );
}

/**
 * @param {*} ast
 * @param { { data: Record<string> } } minifiedMap
 * @param {*} usingComponentsMinifiedMap 当前wxml中自定义组件的可压缩属性
 * @param {*} keepDataAndProperty 暂无跨文件向上链路的追踪, 是否整个wxml文件被用在其他文件<template中的<include标签
 * @param {*} topBindings 整个wxml文件被用在其他文件<template中的<include标签时外部的Bindings
 * @returns
 */
function transformPageOrCompWxml(
  ast,
  minifiedMap,
  filePath,
  usingComponentsMinifiedMap = {},
  keepDataAndProperty = false,
  topBindings = {}
) {
/**
 * @type {import('../src/traverse').traverse}
 */
  traverse(ast, {
    // wx:for 会新增item, wx:for-item会新增属性名的变量, wx:for-index会新增属性名的变量
    /**
     * @param {import('../src/traverse').NodePath} path
     * @param {*} state
     */
    WXElement(path, state) {
      // include标签是否在wx:for的scope下的标签中使用
      const bindings = path.isTop()
        ? topBindings
        : path.scope?.getAllBindings() || {};
      const parentBindings = path.scope?.getParentBinding() || {};
      const node = path.node;
      const { name: eleName } = node.startTag || {};
      const customEle = usingComponentsMinifiedMap[eleName];
      let hasTemplateAncestor =
        keepDataAndProperty ||
        path.findParent((subPath) => types.isTemplateIdent(subPath.node));
      // 这里如果父级存在template则跳过，所以需要在template case时处理掉其所有子元素
      /**
       * - 对于templateIdent,
       *   - 根据其使用的templateInstance处，决定是否压缩
       *   - data, property可以第一阶段先不压, 但是method需要进行压缩
       * - 对于templateInstance
       *   - 仅压缩WXAttribute和data中的{{ key: value }}中的value，或者{{...item}}中的item
       * - 对于普通标签，需要判断，
       *   - 是否祖先元素上存在templateIdent
       *     - 如果存在，则跳过data, property压缩，但method需要处理
       *
       * - 由于template的method直接查找使用的组件和页面中的方法，
       *   - 因此自顶向下来传递method进行压缩
       */
      // - 先不考虑import和include的实现：
      // 如果祖先元素上存在templateIdent，则只压method
      transformAttrsValue(
        node,
        minifiedMap,
        hasTemplateAncestor,
        customEle,
        bindings,
        parentBindings,
        filePath
      );
    },
    WXInterpolation(path, state) {
      let hasTemplateParent =
        keepDataAndProperty ||
        path.findParent((subPath) => types.isTemplateIdent(subPath.node));
      // T这里如果父级存在template则跳过，所以需要在template case时处理掉其所有子元素
      if (hasTemplateParent) return;
      const bindings = path.isTop()
        ? topBindings
        : path.scope?.getAllBindings() || {};
      transformInterpolation(
        path.node,
        {
          ...minifiedMap.data,
          ...minifiedMap.property,
        },
        false,
        bindings
      );
    },
  });
}

/**
 * @param {WXElement} node
 * @param {*} minifiedMap
 * @param {boolean} onlyMethod 当前WXElement是否在template的定义中
 * @param {{ [propName: string]: { type: TYPE, name: string } }} customEle
 */
function transformAttrsValue(
  node,
  minifiedMap,
  onlyMethod,
  customEle,
  bindings,
  parentBindings,
  filePath
) {
  const { attributes: attrs } = node.startTag;
  const isTemplateNode = types.isTemplate(node);
  attrs.forEach((attr) => {
    const { key, interpolations = [], value, children } = attr;
    const isWxFor = key === "wx:for";
    const hasInterpolations = interpolations.length;
    const activeBindings = isWxFor ? parentBindings : bindings;
    if (unsafeIsEventAttr(key)) {
      if (hasInterpolations) {
        logger.error(
          `【wxml】标签的${key}事件绑定的属性值禁止使用{{}}表达式${value} ${filePath}`
        );
      }
      if (minifiedMap.method[value] && !activeBindings[value]) {
        attr.value = minifiedMap.method[value].name;
      }
    } else if (!onlyMethod) {
      if (hasInterpolations) {
        // template的data标签需要特殊的解析规则
        const isTemplateDataAttr = isTemplateNode && attr.key === "data";
        children.forEach((child) => {
          if (types.isWXAttributeInterpolation(child)) {
            transformInterpolation(
              child,
              {
                ...minifiedMap.data,
                ...minifiedMap.property,
              },
              isTemplateDataAttr,
              activeBindings
            );
          }
        });
      }
    }
    if (customEle && customEle[key]) {
      attr.key = customEle[key].name;
    }
  });
}

const { parse } = require('@babel/parser');
const traverseJs = require('@babel/traverse').default;
const { default: generate } = require('@babel/generator');
/**
 * 解析wxml中的expression并进行变量压缩
 * @param {*} node
 * @param {*} minifiedMap
 */
function transformInterpolation(node, minifiedMap, isTemplateDataAttr, bindings) {
    const minifiedNames = Object.keys(minifiedMap).filter(item => !bindings[item]);
    let expressionCode = isTemplateDataAttr ? '{' + node.value + '}' : node.value;
    expressionCode = expressionCode + ';';
    const decls = minifiedNames.length ? `var ${minifiedNames.reduce((res, varName) => res + (res.length ? ',' : '') + varName, '')};` : '';
    const prefix = 'var __spec_result__ = ';
    expressionCode = decls + prefix + expressionCode;
    const ast = parse(expressionCode, {
        plugins: ['exportDefaultFrom'],
        sourceType: 'module',
    });
    const opts = {
        /**
         * 四种情况:
         * - 逻辑表达式
         * - 三元表达式
         * - 嵌套的逻辑
         * - 嵌套的三元
         *
         * @param {*} path
         */
        VariableDeclarator(path) {
            const id = path.get('id');
            if (id.isIdentifier() && id.node.name === '__spec_result__') {
                Object.keys(minifiedMap).forEach(varName => {
                    if (path.scope.hasBinding(varName)) {
                        path.scope.rename(varName, minifiedMap[varName].name);
                    }
                });
            }
        },
    };
    traverseJs(ast, opts);
    const { code: newCode } = generate(ast);
    let newValue = newCode.endsWith(';') ? newCode.slice(0, newCode.length - 1) : newCode;
    newValue = newValue.split('\n').join('');
    newValue = newValue.match(/var __spec_result__ = (.*)/)[1];
    if (isTemplateDataAttr) {
        newValue = newValue
            .split('\n')
            .join('')
            .match(/\{(.*)\}/)[1];
    }
    node.value = newValue;
    return newValue;
}

const content = `
    <view propA="a" propB="{{dataA}}" bindtap="handleClick">
        <template is="t1" data="{{ propT }}" />
        <customComponent1 compPropA="{{dataA}}" bindCustomEvent="handleClick" />
    </view>
    <template name="t1">
        <view propT="{{propT}}" >template</view>
    </template>
`;

const compressed = `
    <view propA="a" propB="{{a}}" bindtap="c">
        <template is="t1" data="{{  propT: t}}" />
        <customComponent1 c_a="{{a}}" bindCustomEvent="c" />
    </view>
    <template name="t1">
        <view propT="{{propT}}">template</view>
    </template>
`
function compressTest() {
  const { parse: parseWxml } = require('@wxml/parser');
  const ast = parseWxml(content);
  transformPageOrCompWxml(ast, {
    data: {
        dataA: {
            name: 'a'
        },
    },
    property: {
        propT: {
            name: 't'
        },
    },
    method: {
        handleClick: {
            name: 'c'
        }
    }
  }, '', {
    customComponent1: {
        compPropA: {
            name: 'c_a'
        }
    }
  });
  const { generate } = require('@wxml/generator');
  const res = generate(ast);
  if (res === compressed) {
    logger.trace(`【压缩测试通过】`);
  } else {
    logger.error(`【压缩测试失败】${res}`);
  }
}

compressTest();
