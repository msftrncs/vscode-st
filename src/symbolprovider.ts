'use strict';
import * as vscode from 'vscode';

export class STDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
    /*
        Consider rewriting this entire symbolprovider to use a recursive symbol extraction method.
        While not all symbol types will be found burried within any given symbol, using a generic recursive aproach
        will yield the most effective capture of symbols.

        Start           | End
        ----------------|----
        PROGRAM             | END_\1
        FUNCTION(?:_BLOCK)?  | END_\1
            ACTION              | END_\1
            VAR(?=_(?:INPUT|OUTPUT|IN_OUT|INST|TEMP|STAT|GLOBAL|ACCESS|EXTERNAL|CONFIG))? | END_\1
            METHOD      | END_\1
        TYPE            | END_\1        TYPE will require a special process due to enumeration.
            STRUCT          | END_\1
            UNION           | END_\1
        IMPLEMENTATION  | END_\1
        INTERFACE       | END_\1

        While looking for the above groups, it is important to not allow the search in certain text,
        Quoted strings  (["'])(?:(?!\1)(?:\$\1|[\s\S]))*(?:\1|$)
        Commented lines \/\/.*(?:\r?\n|$)
        Comment Blocks: \(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)

        The search must consume wholly the parts above, so 'as few as possible but as many as needed' quantifier (*?) must be used along with:
        other text:     [\s\S]

        And all patterns must be allowed to match the end of the document in place of the proper ending mark, but the whole pattern cannot match at the end of the document alone (probably a JavaScript / Chromium / V8 bug):
        base regex: /(?!$)(?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\1)(?:\$\1|[\s\S]))*(?:\1|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?/

    */
    //      Comment blocks  \(\*(?:.(?!/*\)))*\*\)|(\/\*(?:.(?!\*\/))*\*\/ 
    /* (?:(["'])(?:\1\1|[\\s\\S])*?(?:\1(?!\1)|$)|'(?:[^']|'')*'|\/\/.*(?:\r?\n|$)|\(\*[\s\S]*?\*\)|\/\*[\s\S]*?\*\/|(?:(?!\(\*|\/\/|\/\*|['"])[\s\S]))*?\b(TEST)\b*/

    //    regex = /(?!$)((?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\2)(?:\$\2|[\s\S]))*(?:\2|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?)(?:$|\b((PROGRAM|FUNCTION(?:_BLOCK)?|INTERFACE|ACTION|METHOD|TYPE|STRUCT|UNION|VAR(?=\b|_(?:INPUT|OUTPUT|IN_OUT|INST|TEMP|STAT|GLOBAL|ACCESS|EXTERNAL|CONFIG)))(?:\b|(?<=\bVAR)_(?:INPUT|OUTPUT|IN_OUT|INST|TEMP|STAT|GLOBAL|ACCESS|EXTERNAL|CONFIG)))\b((?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\6)(?:\$\6|[\s\S]))*(?:\6|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?)(?:$|\bEND_\4\b|\b(?=(?:END_)?(?:PROGRAM|FUNCTION(?:_BLOCK)?|INTERFACE))\b))/;
    /*
            There is a limitation here.  Any given element cannot be nested within a element of the same type becuse they have matching end markers.
    
            Technically very few elements should be nested within each other anyway:
    
                VAR_x is nested in PROGRAM/FUNCTION(_BLOCK)?, but not in VAR_x
                STRUCT/UNION is nested in TYPE, but not recursively, and mutually exclusive
                PROGRAM/FUNCTION(_BLOCK) are mutually exclusive and should not be nested in any other element
                ACTION may be nested IN 
    */

    public provideDocumentSymbols(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.DocumentSymbol[]> {
        let doc = document.getText();
        return new Promise((resolve, reject) => {
            resolve(recursePouSymbols(doc, 0));

        });

        function recursePouSymbols(text: string, offset: number): vscode.DocumentSymbol[]{
            let symbols: vscode.DocumentSymbol[] = [];
            const rgx_pou = /(?!$)((?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\2)(?:\$\2|[\s\S]))*(?:\2|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?)(?:$|\b((PROGRAM|FUNCTION(?:_BLOCK)?|INTERFACE|ACTION|METHOD|TYPE|VAR(?=\b|_(?:INPUT|OUTPUT|IN_OUT|INST|TEMP|STAT|GLOBAL|ACCESS|EXTERNAL|CONFIG)))(?:\b|(?<=\bVAR)_(?:INPUT|OUTPUT|IN_OUT|INST|TEMP|STAT|GLOBAL|ACCESS|EXTERNAL|CONFIG)))\b((?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\6)(?:\$\6|[\s\S]))*(?:\6|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?)(?:$|\bEND_\4\b|\b(?=(?:END_)?(?:PROGRAM|FUNCTION(?:_BLOCK)?|INTERFACE|TYPE))\b))/ig;
            let pous: RegExpExecArray | null;
            while ((pous = rgx_pou.exec(text)) !== null) {
                if (pous[3] !== undefined) {
                    const pou_start_offset = offset + pous.index + pous[1].length
                    const pou_content_offset = pou_start_offset + pous[3].length;
                    const pou_start_pos = document.positionAt(pou_start_offset);
                    const pou_reveal_range = new vscode.Range(pou_start_pos, document.positionAt(pou_content_offset));
                    const pou_full_range = new vscode.Range(pou_start_pos, document.positionAt(offset + pous.index + pous[0].length));

                    /* Depending on the type of pou, we may or we may not define a symbol:

                        POU             vscode      recurse
                        Keyword         type        type
                        --------------------------------------------------
                        PROGRAM         Module      POU
                        FUNCTION_BLOCK  Class       POU
                        FUNCTION        Function    POU
                        INTERFACE       Interface   POU
                        METHOD          Method      POU
                        ACTION          Event??     none
                        TYPE            File        TYPE
                        VAR(_x)?        File        VAR

                        STRUCT and UNION and enumerations resolve in TYPE recurse.
                        VAR recurse might need to resolve STRUCT and UNION.
                        VAR recurse must ignore modifiers before symbols.
                        VAR recurse might need to iterate multiple symbols in a single definition. (comma)
                        POU recurse must determine the symbol name.
                        INTERFACE might need to allow FUNCTION/FUNCTION_BLOCK and maybe PROGRAM to nested within.

                        rgx_pou_name = /(?!$)((?:(?:\b(?:ABSTRACT|CONSTANT|RETAIN|PERSISTENT|PUBLIC|PRIVATE|PROTECTED|INTERNAL|FINAL)\b)?(?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\2)(?:\$\2|[\s\S]))*(?:\2|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s])*?)*)(?:$|\b(?=(?:(?:END_)?(?:ACTION|METHOD|STRUCT|UNION|(?<=END_)VAR|(?<!END)VAR(?:_(?:INPUT|OUTPUT|IN_OUT|INST|TEMP|STAT|GLOBAL|ACCESS|EXTERNAL|CONFIG))?)|EXTENDS|IMPLEMENTS|PROPERTY)\b)|\b([a-zA-Z0-9_]+)\b|(?=\S))/i

                        capture 3 provides the pou name.  Length of capture 1 and capture 3 offset the text sent to the recurse, as there is no reason to recurse this part.
                    */

                    const pou_type = pous[3].toUpperCase();
                    if (pou_type === "TYPE") {
                        if (pous[5] !== undefined) {
                            recurseTypes(pous[5], pou_content_offset).forEach((item) => {
                                symbols.push(item);
                            });
                        }
        
                    }
                    else if (pou_type.substr(0, 3) === "VAR") {
                        let symbol = new vscode.DocumentSymbol(pou_type, "Variables", vscode.SymbolKind.File, pou_full_range, pou_reveal_range);
                        const vars = listVariablesByOffset(pous[5], pou_content_offset);
                        if (vars !== null) {
                            symbol.children = vars;
                        }
                    symbols.push(symbol);
                    }
                    else {
                        const rgx_pou_name = /(?!$)((?:(?:\b(?:ABSTRACT|CONSTANT|RETAIN|PERSISTENT|PUBLIC|PRIVATE|PROTECTED|INTERNAL|FINAL)\b)?(?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\2)(?:\$\2|[\s\S]))*(?:\2|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s])*?)*)(?:$|\b(?=(?:(?:END_)?(?:ACTION|METHOD|STRUCT|UNION|(?<=END_)VAR|(?<!END)VAR(?:_(?:INPUT|OUTPUT|IN_OUT|INST|TEMP|STAT|GLOBAL|ACCESS|EXTERNAL|CONFIG))?)|EXTENDS|IMPLEMENTS|PROPERTY)\b)|\b([a-zA-Z0-9_]+)\b|(?=\S))/i
                        let pou_name = pous[5].match(rgx_pou_name);
                        let symbol = new vscode.DocumentSymbol(
                            pou_name && pou_name[3] || '<unnamed>', 'Program',
                            vscode.SymbolKind.Module,
                            pou_full_range, pou_reveal_range
                        );
                        const pou_name_offset = pou_name && pou_name[0] !== undefined ? pou_name[0].length : 0;
                        recursePouSymbols(pous[5].substr(pou_name_offset), pou_content_offset + pou_name_offset).forEach((item) => {
                            symbol.children.push(item);
                        });
                        symbols.push(symbol);
                    }
                }

            }
            return symbols;
        }

        function recurseTypes(text: string, offset: number): vscode.DocumentSymbol[] {
            let items: vscode.DocumentSymbol[] = [];
            let rgx_struct = /(?!$)((?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\2)(?:\$\2|[\s\S]))*(?:\2|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?)(?:$|\b([a-zA-Z0-9_]+)\b((?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\5)(?:\$\5|[\s\S]))*(?:\5|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?:(?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\6)(?:\$\6|[\s\S]))*(?:\6|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?)(?:$|(struct|union)\b((?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\9)(?:\$\9|[\s\S]))*(?:\9|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?)\bend_\7\b|([a-zA-Z0-9_]+)\b((?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\12)(?:\$\12|[\s\S]))*(?:\12|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?)(?:;|$)|\((?!\*)((?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\14)(?:\$\14|[\s\S]))*(?:\14|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?)(?:$|\)(?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\15)(?:\$\15|[\s\S]))*(?:\15|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?(?:\b([a-zA-Z0-9_]+)\b(?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\17)(?:\$\17|[\s\S]))*(?:\17|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?)?(?:;|$))))/ig;
            /* Captures break-down
                [1] - header before type name
                [3] - type name
                [7] - STRUCT | UNION
                [8] - struct constructor
                [10] - synonym type base type
                [11] - synonym type constructor
                [13] - enumeration constructor
                [16] - enumeration base type expression
            */
            let ms: RegExpExecArray | null;
            while ((ms = rgx_struct.exec(text)) !== null) {
                if (ms[3] !== undefined) {
                    const struct_offset = offset + ms.index + ms[1].length;
                    const struct_pos = document.positionAt(struct_offset);
                    const isEnum = ms[13] !== undefined;
                    let item = new vscode.DocumentSymbol(
                        (isEnum && ms[16] !== undefined) ? (ms[3] + " (" + ms[16] + ")") :
                            ms[10] !== undefined ? (ms[3] + " (" + ms[10] + ")") : ms[3],
                        isEnum ? 'Enumeration' : ((ms[7] === undefined || ms[7].toUpperCase() === 'STRUCT') ? 'Structure' : 'Union'),
                        isEnum ? vscode.SymbolKind.Enum : vscode.SymbolKind.Struct,
                        new vscode.Range(struct_pos, document.positionAt(offset + ms.index + ms[0].length)),
                        new vscode.Range(struct_pos, document.positionAt(struct_offset + ms[3].length))
                    );
                    if (!isEnum) {
                        if (ms[8] !== undefined) {
                            const content_offset = struct_offset + ms[3].length + ms[4].length + ms[7].length;
                            const vars = listVariablesByOffset(ms[8], content_offset);
                            if (vars !== null) {
                                item.children = vars;
                            }
                        }
                    }

                    else {
                        const content_offset = struct_offset + ms[3].length + ms[4].length + 1;
                        const rgx_enums = /(?!$)((?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\2)(?:\$\2|[\s\S]))*(?:\2|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?)(?:$|\b([a-zA-Z0-9_]+)\b(?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\4)(?:\$\4|[\s\S]))*(?:\4|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?(?:,|$)(?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\5)(?:\$\5|[\s\S]))*(?:\5|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s])*)/ig;
                        let enums: RegExpExecArray | null;
                        while ((enums = rgx_enums.exec(ms[13])) !== null) {
                            if (enums[3] !== undefined) {
                                const enums_offset = content_offset + enums.index + enums[1].length;
                                const enums_pos = document.positionAt(enums_offset);
                                let em = new vscode.DocumentSymbol(
                                    enums[3], 'Enumerator',
                                    vscode.SymbolKind.EnumMember,
                                    new vscode.Range(enums_pos, document.positionAt(content_offset + enums.index + enums[0].length)),
                                    new vscode.Range(enums_pos, document.positionAt(enums_offset + enums[3].length))
                                );
                                item.children.push(em);
                            }
                        };
                    }
                    items.push(item);
                }
            }
            return items;
        }

        /*
        function getPouSymbols(symbol: vscode.DocumentSymbol, scope: string, ln: number): vscode.DocumentSymbol {
            let varsList: { varKeyword: string, desc: string }[] = [
                { varKeyword: 'VAR', desc: 'Local variables' },
                { varKeyword: 'VAR_TEMP', desc: 'Local variables' },
                { varKeyword: 'VAR_INPUT', desc: 'Input variables' },
                { varKeyword: 'VAR_OUTPUT', desc: 'Output variables' },
                { varKeyword: 'VAR_IN_OUT', desc: 'Through variables' },
                { varKeyword: 'VAR_INST', desc: 'Instance variables' },  // ??
                { varKeyword: 'VAR_STAT', desc: 'Status variables' },  // ??
                { varKeyword: 'VAR_ACCESS', desc: 'Access variables' }, // ??
                { varKeyword: 'VAR_EXTERNAL', desc: 'External variables' }, // ??
                { varKeyword: 'VAR_CONFIG', desc: 'Configuration variables' }]; // ??

            varsList.forEach((vars) => {
                let var_symbols = getVar(vars.varKeyword, scope, ln, vars.desc);
                if (var_symbols !== null) {
                    symbol.children.push(var_symbols);
                }
            });

            return symbol;
        }*/

//        function getVar(vars: string, scope: string, ln: number, description: string): vscode.DocumentSymbol | null {
//            let regex = new RegExp(`(?!$)((?://.*(?:\\r?\\n|$)|(["'])(?:(?!\\2)(?:\\$\\2|[\\s\\S]))*(?:\\2|$)|\\(\\*[\\s\\S]*?(?:\\*\\)|$)|/\\*[\\s\\S]*?(?:\\*/|$)|[\\s\\S])*?)(?:$|\\b${vars}\\b((?:(?:\\b(?:CONSTANT|RETAIN|PERSISTENT)\\b)?(?://.*(?:\\r?\\n|$)|(["'])(?:(?!\\4)(?:\\$\\4|[\\s\\S]))*(?:\\4|$)|\\(\\*[\\s\\S]*?(?:\\*\\)|$)|/\\*[\\s\\S]*?(?:\\*/|$)|[\\s])*?)*)((?://.*(?:\\r?\\n|$)|(["'])(?:(?!\\6)(?:\\$\\6|[\\s\\S]))*(?:\\6|$)|\\(\\*[\\s\\S]*?(?:\\*\\)|$)|/\\*[\\s\\S]*?(?:\\*/|$)|[\\s\\S])*?)(?:end_var|$)\\b)`, "i");
/*            let m = scope.match(regex);
            if (m && m[5] !== undefined) {
                let ln2 = getLineNum(scope, m[0]);
                let symbols = listVariables(m[5], ln + ln2);

                let range = getRange(getLineNum(doc, m[0]));
                let child = new vscode.DocumentSymbol(vars, description, vscode.SymbolKind.File, range, range);
                if (symbols.length > 0) {
                    child.children = symbols;
                }
                return child;
            }

            return null;
        }*/
/*
        function listVariables(text: string, ln: number): vscode.DocumentSymbol[] {
            let symbols: vscode.DocumentSymbol[] = []; */
//            let rgx_variables = /(?!$)((?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\2)(?:\$\2|[\s\S]))*(?:\2|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?)(?:$|\b([a-zA-Z0-9_]+)\b((?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\5)(?:\$\5|[\s\S]))*(?:\5|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?:(?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\6)(?:\$\6|[\s\S]))*(?:\6|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?)([a-zA-Z0-9_]+)\b((?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\12)(?:\$\12|[\s\S]))*(?:\12|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?)(?:;|$)(?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\10)(?:\$\10|[\s\S]))*(?:\10|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s])*)/ig;
/*            let vars: RegExpExecArray | null;
            while ((vars = rgx_variables.exec(text)) !== null) {
                if (vars[3] !== undefined) {
                    let range = getRange(0 + ln);
                    let item = new vscode.DocumentSymbol(
                        vars[3] + (vars[7] === undefined ? '' : (' (' + vars[7] + ')')), 'Variable',
                        vscode.SymbolKind.Variable,
                        range, range
                    );

                    symbols.push(item);
                }
            };
            return symbols;
        }*/

        function listVariablesByOffset(text: string, offset: number): vscode.DocumentSymbol[] {
            let symbols: vscode.DocumentSymbol[] = [];
            let rgx_variables = /(?!$)((?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\2)(?:\$\2|[\s\S]))*(?:\2|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?)(?:$|\b([a-zA-Z0-9_]+)\b((?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\5)(?:\$\5|[\s\S]))*(?:\5|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?:(?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\6)(?:\$\6|[\s\S]))*(?:\6|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?)([a-zA-Z0-9_]+)\b((?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\12)(?:\$\12|[\s\S]))*(?:\12|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?)(?:;|$)(?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\10)(?:\$\10|[\s\S]))*(?:\10|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s])*)/ig;
            let vars: RegExpExecArray | null;
            while ((vars = rgx_variables.exec(text)) !== null) {
                if (vars[3] !== undefined) {
                    let vars_offset = offset + vars.index + vars[1].length;
                    let vars_pos = document.positionAt(vars_offset);
                    let item = new vscode.DocumentSymbol(
                        vars[3] + (vars[7] === undefined ? '' : (' (' + vars[7] + ')')), 'Variable',
                        vscode.SymbolKind.Variable,
                        new vscode.Range(vars_pos, document.positionAt(offset + vars.index + vars[0].length)),
                        new vscode.Range(vars_pos, document.positionAt(vars_offset + vars[3].length))
                    );

                    symbols.push(item);
                }
            };
            return symbols;
        }
/*
        function getLineNum(text: string, substring: string): number {
            var index = text.indexOf(substring);
            var tempString = text.substring(0, index);
            return tempString.split('\n').length - 1;
        }

        function getRange(ln: number): vscode.Range {
            let pos1 = new vscode.Position(ln, 0);
            let pos2 = new vscode.Position(ln, 1);
            return new vscode.Range(pos1, pos2);
        }*/
 /*
        old code
             /*let symbols: vscode.DocumentSymbol[] = [];

            let m: RegExpExecArray | null;

            let regex = /\bprogram\s*\b([a-zA-Z0-9_]*)\b([\s\S]*?)\bend_program\b/img;
            while ((m = regex.exec(doc)) !== null) {
                let ln = getLineNum(doc, m[0]);
                let range = getRange(ln);
                let item = new vscode.DocumentSymbol(
                    m[1] || '<unnamed>', 'Program',
                    vscode.SymbolKind.Module,
                    range, range
                );

                symbols.push(getPouSymbols(item, m[0], ln));
            }

            regex = /(?!$)((?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\2)(?:\$\2|[\s\S]))*(?:\2|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?)(?:\btype\b((?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\4)(?:\$\4|[\s\S]))*(?:\4|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?)(?:\bend_type\b|$)|$)/ig;
            while ((m = regex.exec(doc)) !== null) {
                let type_offset = m.index + m[1].length + (m[3] === undefined ? 0 : 4);
                if (m[3] !== undefined) {
                    recurseTypes(m[3], type_offset).forEach((item) => {
                        symbols.push(item);
                    });
                }
            }

            regex = /\bfunction_block\s*\b([a-zA-Z0-9_]*)\b([\s\S]*?)\bend_function_block\b/img;
            while ((m = regex.exec(doc)) !== null) {
                let ln = getLineNum(doc, m[0]);
                let range = getRange(ln);
                let item = new vscode.DocumentSymbol(
                    m[1] || '<unnamed>', 'Function block',
                    vscode.SymbolKind.Class,
                    range, range
                );

                symbols.push(getPouSymbols(item, m[0], ln));
            }

            regex = /\bfunction\s*\b([a-zA-Z0-9_]*)\b\s*:\s*\b([a-zA-Z0-9_]*)\b([\s\S]*?)end_function\b/img;
            while ((m = regex.exec(doc)) !== null) {
                let ln = getLineNum(doc, m[0]);
                let range = getRange(ln);
                let item = new vscode.DocumentSymbol(
                    (m[1] || '<unnamed>') + " (" + m[2] + ")", 'Function',
                    vscode.SymbolKind.Function,
                    range, range
                );

                symbols.push(getPouSymbols(item, m[3], ln));
            }

            // temporary including VAR_GLOBAL
            let var_symbols = getVar('VAR_GLOBAL', doc, 0, 'Global variables');
            if (var_symbols !== null) {
                symbols.push(var_symbols);
            }


            resolve(symbols); */

    }
}