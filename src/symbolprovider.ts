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
        TYPE            | END_\1
        STRUCT          | END_\1
        UNION           | END_\1

        While looking for the above groups, it is important to not allow the search in certain text,
        Quoted strings "(?:[^"]|"")*"|'(?:[^']|'')*'
        Commented lines //[^\n]*\n */
    //      Comment blocks  \(\*(?:.(?!/*\)))*\*\)|(\/\*(?:.(?!\*\/))*\*\/ 
    /* (?:(["'])(?:\1\1|[\\s\\S])*?(?:\1(?!\1)|$)|'(?:[^']|'')*'|\/\/.*(?:\n|$)|\(\*[\s\S]*?\*\)|\/\*[\s\S]*?\*\/|(?:(?!\(\*|\/\/|\/\*|['"])[\s\S]))*?\b(TEST)\b*/

    //    regex = /(?:"(?:[^"]|"")*"|'(?:[^']|'')*'|\/\/.*(?:\n|$)|\(\*[\s\S]*?\*\)|\/\*[\s\S]*?\*\/|(?:(?!\(\*|\/\/|\/\*|['"])[\s\S]))*?\b((PROGRAM|FUNCTION(?:_BLOCK)?|ACTION|TYPE|STRUCT|UNION|VAR(?=\b|_(?:INPUT|OUTPUT|IN_OUT|INST|TEMP|STAT|GLOBAL|ACCESS|EXTERNAL|CONFIG)))(?:\b|(?<=VAR)_(?:INPUT|OUTPUT|IN_OUT|INST|TEMP|STAT|GLOBAL|ACCESS|EXTERNAL|CONFIG)))\b((?:"(?:[^"]|"")*"|'(?:[^']|'')*'|\/\/.*(?:\n|$)|\(\*[\s\S]*?\*\)|\/\*[\s\S]*?\*\/|(?:(?!\(\*|\/\/|\/\*|['"])[\s\S]))*?)\bEND_\2\b/;
    /*
            There is a limitation here.  Any given element cannot be nested within a element of the same type becuse they have matching end markers.
    
            Technically very few elements should be nested within each other anyway:
    
                VAR_x is nexted in PROGRAM/FUNCTION(_BLOCK), but not in VAR_x
                STRUCT/UNION is nested in TYPE, but not recursively, and mutually exclusive
                PROGRAM/FUCTION(_BLOCK) are mutually exclusive and should not be nested in any other element
                ACTION may be nested
    */

    public provideDocumentSymbols(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.DocumentSymbol[]> {
        return new Promise((resolve, reject) => {
            let symbols: vscode.DocumentSymbol[] = [];

            let doc = document.getText();
            let m;

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
            //      |"(?:[^"]|"")*"|'(?:[^']|'')*'|\/\/.*(?:\n|$)|\/\*[\s\S]*?\*\/|\(\*[\s\S]*?\*\)
            //(?:"(?:[^"]|"")*"|'(?:[^']|'')*'|\/\/.*(?:\n|$)|\(\*[\s\S]*?\*\)|\/\*[\s\S]*?\*\/|(?:(?!\(\*|\/\/|\/\*|['"])[\s\S]))*?
            //`(?<!\\\\(?:\\\\{2})*)["']{1}[^"'\\\\]*(?:\\\\[\\s\\S][^\\\\"']*)*["']{1}|\\(\\*[\\s\\S]*?\\*\\)|\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*\\n`
            //(?:\/\/.*(?:\n|$)|(["'])(?:(?!\1)(?:\$\1|[\s\S]))*(?:\1|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?/
            regex = /(?!$)(?:\/\/.*(?:\n|$)|(["'])(?:(?!\1)(?:\$\1|[\s\S]))*(?:\1|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?(?:\btype\b((?:\/\/.*(?:\n|$)|(["'])(?:(?!\3)(?:\$\3|[\s\S]))*(?:\3|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?)(?:\bend_type\b|$)|$)/ig;
            while ((m = regex.exec(doc)) !== null) {
                let rgx_struct = /\b([a-zA-Z0-9_]*)\b\s*:\s*(?:(struct|union)\b([\s\S]*?)\bend_\2\b|([a-zA-Z0-9_]*)\b([\s\S]*?);)/img;
                let ms: RegExpExecArray | null;
                while ((ms = rgx_struct.exec(m[2])) !== null) {
                    let ln = this.getLineNum(doc, ms[0]);
                    let range = this.getRange(ln);
                    let item = new vscode.DocumentSymbol(
                        ms[1], ms[2], //'Structure',
                        vscode.SymbolKind.Struct,
                        range, range
                    );
                    let vars = this.listVariables(ms[0], ln);
                    if (vars !== null) {
                        item.children = vars;
                    }
                    symbols.push(item);
                }

                let rgx_enum = /\b([a-zA-Z0-9_]*)\b\s*:\s*\(([\s\S]*?)\)[\s\S]*?;/img;
                while ((ms = rgx_enum.exec(m[2])) !== null) {
                    let ln = this.getLineNum(doc, ms[0]);
                    let range = this.getRange(ln);
                    let item = new vscode.DocumentSymbol(
                        ms[1], 'Enumeration',
                        vscode.SymbolKind.Enum,
                        range, range
                    );
                    let enums = ms[2].split(',');
                    let contx = ms[2];
                    // TODO: Better get every parameter
                    enums.forEach(element => {
                        let emm = element.match(/^\s*\b([A-Za-z_0-9]*)\b/);
                        if (emm === null) {
                            emm = element.match(/\b([A-Za-z_0-9]*)\b\s*(:=\s*[0-9]*)?\s*$/);
                        }
                        if (emm !== null) {
                            let en_ln = this.getLineNum(contx, element);
                            let range = this.getRange(ln + (en_ln > 0 ? en_ln + 1 : en_ln));
                            let e = new vscode.DocumentSymbol(
                                emm[1], 'Enumerator',
                                vscode.SymbolKind.Variable,
                                range, range
                            );
                            item.children.push(e);
                        }
                    });

                    symbols.push(item);
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
        let lines = text.split('\n');
        lines.forEach((line, key) => {
            let variables = line.match(/\b([a-zA-Z0-9_]*)\b([^:]*):\s*([a-zA-Z0-9_]*)\b([^;]*);\s*(\(\*(.*)\*\))?/);
            if (variables !== null) {
                let range = this.getRange(key + ln);
                if (variables !== null && variables.length > 1) {
                    let item = new vscode.DocumentSymbol(
                        variables[1] + ' (' + variables[3] + ') ' + (variables[2] !== undefined ? variables[2] : ''), variables[6] || 'Variable',
                        vscode.SymbolKind.Variable,
                        range, range
                    );

                    symbols.push(item);
                }
            }
        });
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