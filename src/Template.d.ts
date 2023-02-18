export declare interface ITemplateIdent {
    name: string;
    local?: boolean;
    sourceFile?: string;
}

export declare interface ITemplateInstance {
    is: string;
    local?: boolean;
}

export declare interface IWxmlMeta<T> {
    imports?: ({
        meta: IWxmlMeta<T>;
        isTop?: boolean; // 是否在wxml顶级作用域下
    } & T)[]; // templateIdent是一层的
    includes?: (T & {
        meta: IWxmlMeta<T>;
        inTemplateIdent?: boolean; // 是否在template定义中使用
    })[]; // 相当于拷贝，template是拷贝无效的
    localTemplateIdentities: {
        [name: string]: ITemplateIdent,
    };
    localTemplateInstances: {
        [name: string]: ITemplateInstance
    };
    getAllTemplates(): ITemplateIdent[];
}