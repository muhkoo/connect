export * from './browser';
export * from './crypto';
export * from './events';
export * from './messaging';
export * from './types';
export * from './utilities';
export * from './core';

export interface Attribute {
    dataType: string;
    attribute: string;
    value: string | number | boolean | Array<string | boolean | number> | object;
}

export type Tag = string;

export interface FileOptions {
    id?: string,
    name?: string,
    size?: number,
    hash?: string,
    contentType?: string,
    path?: string,
    isArchived?: boolean
    version?: number,
    attributes?: Attribute[];
    tags?: string[]
}

export interface FilesInterface {
    id?: string;
    name: string;
    size: number;
    hash: string;
    contentType: string;
    version: number;
    tags: Tag[];
    attributes: Attribute[];
}
