'use strict';
import * as vscode from 'vscode';

export class stDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
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
        return new Promise((resolve, reject) => {
            let symbols: vscode.DocumentSymbol[] = [];

            let doc = document.getText();
            let m: RegExpExecArray | null;

            let regex = /\bprogram\s*\b([a-zA-Z0-9_]*)\b([\s\S]*?)\bend_program\b/img;
            while ((m = regex.exec(doc)) !== null) {
                let ln = this.getLineNum(doc, m[0]);
                let range = this.getRange(ln);
                let item = new vscode.DocumentSymbol(
                    m[1], 'Program',
                    vscode.SymbolKind.Module,
                    range, range
                );

                item = this.getPouSymbols(item, m[0], doc, ln);

                symbols.push(item);
            }
            //      |"(?:[^"]|"")*"|'(?:[^']|'')*'|\/\/.*(?:\r?\n|$)|\/\*[\s\S]*?\*\/|\(\*[\s\S]*?\*\)
            //(?:"(?:[^"]|"")*"|'(?:[^']|'')*'|\/\/.*(?:\r?\n|$)|\(\*[\s\S]*?\*\)|\/\*[\s\S]*?\*\/|(?:(?!\(\*|\/\/|\/\*|['"])[\s\S]))*?
            //`(?<!\\\\(?:\\\\{2})*)["']{1}[^"'\\\\]*(?:\\\\[\\s\\S][^\\\\"']*)*["']{1}|\\(\\*[\\s\\S]*?\\*\\)|\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*\\n`
            //(?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\1)(?:\$\1|[\s\S]))*(?:\1|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?/
            regex = /(?!$)((?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\2)(?:\$\2|[\s\S]))*(?:\2|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?)(?:\btype\b((?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\4)(?:\$\4|[\s\S]))*(?:\4|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?)(?:\bend_type\b|$)|$)/ig;
            while ((m = regex.exec(doc)) !== null) {
                let type_offset = m.index + m[1].length + (m[3] === undefined? 0 : 4);

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
                while ((ms = rgx_struct.exec(m[3])) !== null) {
                    if (ms[3] !== undefined) {
                        let struct_offset = type_offset + ms.index + ms[1].length;
                        let struct_pos = document.positionAt(struct_offset);
                        let isEnum = ms[13] !== undefined;
                        let item = new vscode.DocumentSymbol(
                            (isEnum && ms[16] !== undefined ) ? (ms[3] + " (" + ms[16] + ")") : 
                                ms[10] !== undefined ? (ms[3] + " (" + ms[10] + ")") : ms[3], 
                            isEnum ? 'Enumeration' : ((ms[7] === undefined || ms[7].toUpperCase() === 'STRUCT') ? 'Structure' : 'Union'),
                            isEnum ? vscode.SymbolKind.Enum : vscode.SymbolKind.Struct,
                            new vscode.Range(struct_pos, document.positionAt(type_offset + ms.index + ms[0].length)), 
                            new vscode.Range(struct_pos, document.positionAt(struct_offset + ms[3].length)) 
                        );
                        if (!isEnum) {
                            if (ms[8] !== undefined) {
                                let content_offset = struct_offset + ms[3].length + ms[4].length + ms[7].length;
                                let vars = this.listVariablesWithDoc(document, ms[8], content_offset);
                                if (vars !== null) {
                                    item.children = vars;
                                }
                            }
                        }

                        else  {
                            let content_offset = struct_offset + ms[3].length + ms[4].length + 1;
                            let rgx_enums = /(?!$)((?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\2)(?:\$\2|[\s\S]))*(?:\2|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?)(?:$|\b([a-zA-Z0-9_]+)\b(?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\4)(?:\$\4|[\s\S]))*(?:\4|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?(?:,|$)(?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\5)(?:\$\5|[\s\S]))*(?:\5|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s])*)/ig;
                            let enums: RegExpExecArray | null;
                            while ((enums = rgx_enums.exec(ms[13])) !== null) {
                                if (enums[3] !== undefined) {
                                    let enums_offset = content_offset + enums.index + enums[1].length;
                                    let enums_pos = document.positionAt(enums_offset);
                                    let e = new vscode.DocumentSymbol(
                                        enums[3], 'Enumerator',
                                        vscode.SymbolKind.EnumMember,
                                        new vscode.Range(enums_pos, document.positionAt(content_offset + enums.index + enums[0].length)), 
                                        new vscode.Range(enums_pos, document.positionAt(enums_offset + enums[3].length))
                                    );
                                    item.children.push(e);
                                }
                            };
                        }
                        symbols.push(item);
                    }
                }

            }

            regex = /\bfunction_block\s*\b([a-zA-Z0-9_]*)\b([\s\S]*?)\bend_function_block\b/img;
            while ((m = regex.exec(doc)) !== null) {
                let ln = this.getLineNum(doc, m[0]);
                let range = this.getRange(ln);
                let item = new vscode.DocumentSymbol(
                    m[1], 'Function block',
                    vscode.SymbolKind.Class,
                    range, range
                );

                item = this.getPouSymbols(item, m[0], doc, ln);

                symbols.push(item);
            }

            regex = /\bfunction\s*\b([a-zA-Z0-9_]*)\b\s*:\s*\b([a-zA-Z0-9_]*)\b([\s\S]*?)end_function/img;
            while ((m = regex.exec(doc)) !== null) {
                let ln = this.getLineNum(doc, m[0]);
                let range = this.getRange(ln);
                let item = new vscode.DocumentSymbol(
                    m[1] + " (" + m[2] + ")", 'Function',
                    vscode.SymbolKind.Function,
                    range, range
                );

                item = this.getPouSymbols(item, m[0], doc, ln);

                symbols.push(item);
            }

            resolve(symbols);
        });
    }

    private getPouSymbols(symbols: vscode.DocumentSymbol, scope: string, doc: string, ln: number): vscode.DocumentSymbol {
        let var_local = this.getVar('VAR', scope, doc, ln, 'Local variables');
        if (var_local !== null) {
            symbols.children.push(var_local);
        }
        let var_temp = this.getVar('VAR_TEMP', scope, doc, ln, 'Local variables');
        if (var_temp !== null) {
            symbols.children.push(var_temp);
        }
        let var_input = this.getVar('VAR_INPUT', scope, doc, ln, 'Input variables');
        if (var_input !== null) {
            symbols.children.push(var_input);
        }
        let var_output = this.getVar('VAR_OUTPUT', scope, doc, ln, 'Output variables');
        if (var_output !== null) {
            symbols.children.push(var_output);
        }
        let var_in_out = this.getVar('VAR_IN_OUT', scope, doc, ln, 'Through variables');
        if (var_in_out !== null) {
            symbols.children.push(var_in_out);
        }

        return symbols;
    }

    private getVar(vars: string, scope: string, doc: string, ln: number, description: string): vscode.DocumentSymbol | null {
        let symbols: vscode.DocumentSymbol[] = [];
        let regex = new RegExp('\\b' + vars + "\\b([\\s\\S]*?)end_var\\b", "img");
        let m = scope.match(regex);
        if (m !== null) {
            let ln2 = this.getLineNum(scope, m[0]);
            symbols = this.listVariables(m[0], ln + ln2);

            if (symbols.length > 0) {
                let range = this.getRange(this.getLineNum(doc, m[0]));
                let child = new vscode.DocumentSymbol(vars, description, vscode.SymbolKind.Constructor, range, range);
                child.children = symbols;
                return child;
            }

        }

        return null;
    }

    private listVariables(text: string, ln: number): vscode.DocumentSymbol[] {
        let symbols: vscode.DocumentSymbol[] = [];
        let rgx_variables = /(?!$)((?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\2)(?:\$\2|[\s\S]))*(?:\2|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?)(?:$|\b([a-zA-Z0-9_]+)\b((?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\5)(?:\$\5|[\s\S]))*(?:\5|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?:(?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\6)(?:\$\6|[\s\S]))*(?:\6|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?)([a-zA-Z0-9_]+)\b((?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\12)(?:\$\12|[\s\S]))*(?:\12|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?)(?:;|$)(?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\10)(?:\$\10|[\s\S]))*(?:\10|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s])*)/ig;
        let vars: RegExpExecArray | null;
        while((vars = rgx_variables.exec(text)) !== null) {
            if (vars[3] !== undefined) {
                let range = this.getRange(0 + ln);
                let item = new vscode.DocumentSymbol(
                    vars[3] + (vars[7] === undefined ? '' : (' (' + vars[7] + ')')), 'Variable',
                    vscode.SymbolKind.Variable,
                    range, range
                );

                symbols.push(item);
            }
        };
        return symbols;
    }

    private listVariablesWithDoc(document: vscode.TextDocument, text: string, offset: number): vscode.DocumentSymbol[] {
        let symbols: vscode.DocumentSymbol[] = [];
        let rgx_variables = /(?!$)((?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\2)(?:\$\2|[\s\S]))*(?:\2|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?)(?:$|\b([a-zA-Z0-9_]+)\b((?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\5)(?:\$\5|[\s\S]))*(?:\5|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?:(?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\6)(?:\$\6|[\s\S]))*(?:\6|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?)([a-zA-Z0-9_]+)\b((?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\12)(?:\$\12|[\s\S]))*(?:\12|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?)(?:;|$)(?:\/\/.*(?:\r?\n|$)|(["'])(?:(?!\10)(?:\$\10|[\s\S]))*(?:\10|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s])*)/ig;
        let vars: RegExpExecArray | null;
        while((vars = rgx_variables.exec(text)) !== null) {
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

    private getLineNum(text: string, substring: string): number {
        var index = text.indexOf(substring);
        var tempString = text.substring(0, index);
        return tempString.split('\n').length - 1;
    }
    private getRange(ln: number): vscode.Range {
        let pos1 = new vscode.Position(ln, 0);
        let pos2 = new vscode.Position(ln, 1);
        return new vscode.Range(pos1, pos2);
    }
}