'use strict';
import * as vscode from 'vscode';

interface IPouBlockDesc { PouBlock: string, SymType: vscode.SymbolKind, Desc: string };
interface IVarBlockDesc { varKeyword: string, desc: string };

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
        Commented lines \/\/.*(?=\r?\n|$)
        Comment Blocks: \(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)

        The search must consume wholly the parts above, so 'as few as possible but as many as needed' quantifier (*?) must be used along with:
        other text:     [\s\S]

        And all patterns must be allowed to match the end of the document in place of the proper ending mark, but the whole pattern cannot match at the end of the document alone (probably a JavaScript / Chromium / V8 bug):
        base regex: /(?!$)(?:\/\/.*(?=\r?\n|$)|(["'])(?:(?!\1)(?:\$\1|[\s\S]))*(?:\1|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?/

        Pattern for identifiers (case insensitive): \b[A-Z_](?:[A-Z0-9]|(?<!_)_)*\b

    */
    //      Comment blocks  \(\*(?:.(?!/*\)))*\*\)|(\/\*(?:.(?!\*\/))*\*\/ 
    /* (?:(["'])(?:\1\1|[\\s\\S])*?(?:\1(?!\1)|$)|'(?:[^']|'')*'|\/\/.*(?=\r?\n|$)|\(\*[\s\S]*?\*\)|\/\*[\s\S]*?\*\/|(?:(?!\(\*|\/\/|\/\*|['"])[\s\S]))*?\b(TEST)\b*/

    //    regex = /(?!$)((?:\/\/.*(?=\r?\n|$)|(["'])(?:(?!\2)(?:\$\2|[\s\S]))*(?:\2|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?)(?:$|\b((PROGRAM|FUNCTION(?:_BLOCK)?|INTERFACE|ACTION|METHOD|TYPE|STRUCT|UNION|VAR(?=\b|_(?:INPUT|OUTPUT|IN_OUT|INST|TEMP|STAT|GLOBAL|ACCESS|EXTERNAL|CONFIG)))(?:\b|(?<=\bVAR)_(?:INPUT|OUTPUT|IN_OUT|INST|TEMP|STAT|GLOBAL|ACCESS|EXTERNAL|CONFIG)))\b((?:\/\/.*(?=\r?\n|$)|(["'])(?:(?!\6)(?:\$\6|[\s\S]))*(?:\6|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?)(?:$|\bEND_\4\b|\b(?=(?:END_)?(?:PROGRAM|FUNCTION(?:_BLOCK)?|INTERFACE))\b))/;
    /*
            There is a limitation here.  Any given element cannot be nested within a element of the same type becuse they have matching end markers.
    
            Technically very few elements should be nested within each other anyway:
    
                VAR_x is nested in PROGRAM/FUNCTION(_BLOCK)?, but not in VAR_x
                STRUCT/UNION is nested in TYPE, but not recursively, and mutually exclusive
                PROGRAM/FUNCTION(_BLOCK) are mutually exclusive and should not be nested in any other element
                ACTION may be nested IN 
    */

    // a lookup for resolving the generically handled POU blocks in to Symbols
    private PouBlocksList: IPouBlockDesc[] = [
        { PouBlock: "PROGRAM", SymType: vscode.SymbolKind.Module, Desc: "Program" },
        { PouBlock: "FUNCTION", SymType: vscode.SymbolKind.Function, Desc: "Function" },
        { PouBlock: "FUNCTION_BLOCK", SymType: vscode.SymbolKind.Class, Desc: "Function block" },
        { PouBlock: "INTERFACE", SymType: vscode.SymbolKind.Interface, Desc: "Interface" },
        { PouBlock: "METHOD", SymType: vscode.SymbolKind.Method, Desc: "Method" },
        { PouBlock: "ACTION", SymType: vscode.SymbolKind.Event, Desc: "Action" },
    ]

    // a lookup for resolving the generically handled VAR blocks in to Symbols
    private varBlocksList: IVarBlockDesc[] = [
        { varKeyword: 'VAR', desc: 'Local variables' },
        { varKeyword: 'VAR_TEMP', desc: 'Local variables' },
        { varKeyword: 'VAR_INPUT', desc: 'Input variables' },
        { varKeyword: 'VAR_OUTPUT', desc: 'Output variables' },
        { varKeyword: 'VAR_IN_OUT', desc: 'Through variables' },
        { varKeyword: 'VAR_INST', desc: 'Instance variables' }, 
        { varKeyword: 'VAR_STAT', desc: 'Static variables' },
        { varKeyword: 'VAR_ACCESS', desc: 'Remote access variables' }, // ??
        { varKeyword: 'VAR_EXTERNAL', desc: 'External variables' },
        { varKeyword: 'VAR_GLOBAL', desc: 'Global variables' },
        { varKeyword: 'VAR_CONFIG', desc: 'Configuration variables' }]; // ??

    public provideDocumentSymbols(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.DocumentSymbol[]> {
        const doc = document.getText();
        const PouBlockDesc = this.PouBlocksList;
        const VarBlockDesc = this.varBlocksList;
        return new Promise((resolve, reject) => {
            resolve(recursePouSymbols(doc, 0));

        });

        function recursePouSymbols(text: string, offset: number): vscode.DocumentSymbol[] {
            let symbols: vscode.DocumentSymbol[] = [];
            // regex determines boundaries for POU's and which POU's are nested in other POU's
            const rgx_pou = /(?!$)((?:\/\/.*(?=\r?\n|$)|(["'])(?:(?!\2)(?:\$\2|[\s\S]))*(?:\2|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?)(?:$|\b((PROGRAM|FUNCTION(?:_BLOCK)?|INTERFACE|ACTION|METHOD|TYPE|VAR(?=\b|_(?:INPUT|OUTPUT|IN_OUT|INST|TEMP|STAT|GLOBAL|ACCESS|EXTERNAL|CONFIG)))(?:\b|(?<=VAR)_(?:INPUT|OUTPUT|IN_OUT|INST|TEMP|STAT|GLOBAL|ACCESS|EXTERNAL|CONFIG)))\b((?<!ACTION|METHOD|INTERFACE)(?:\/\/.*(?=\r?\n|$)|(["'])(?:(?!\6)(?:\$\6|[\s\S]))*(?:\6|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?(?:$|\bEND_\4\b|\b(?=(?:END_)?(?:PROGRAM|FUNCTION(?:_BLOCK)?|INTERFACE|TYPE)\b))|(?<=ACTION|METHOD)(?:\/\/.*(?=\r?\n|$)|(["'])(?:(?!\7)(?:\$\7|[\s\S]))*(?:\7|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?(?:$|\bEND_\4\b|\b(?=(?:END_)?(?:PROGRAM|FUNCTION(?:_BLOCK)?|INTERFACE|TYPE|ACTION|METHOD)\b))|(?<=INTERFACE)(?:\/\/.*(?=\r?\n|$)|(["'])(?:(?!\8)(?:\$\8|[\s\S]))*(?:\8|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?(?:$|\bEND_\4\b)))/iy;
            /* Captures break-down
                [1] - header before POU
                [3] - POU Block name
                [5] - POU Body including name and attributes
            */
            let pous: RegExpExecArray | null;
            while ((pous = rgx_pou.exec(text)) !== null) {
                if (pous[3] !== undefined) {
                    const pou_offset = offset + pous.index;
                    const pou_start_offset = pou_offset + pous[1].length;
                    const pou_content_offset = pou_start_offset + pous[3].length;
                    const pou_start_pos = document.positionAt(pou_start_offset);
                    const pou_reveal_range = new vscode.Range(pou_start_pos, document.positionAt(pou_content_offset));
                    const pou_full_range = new vscode.Range(pou_start_pos, document.positionAt(pou_offset + pous[0].length));

                    const pou_type = pous[3].toUpperCase();
                    if (pou_type === "TYPE") {
                        if (pous[5] !== undefined) {
                            listVariables(pous[5], pou_content_offset, true).forEach(item => {
                                symbols.push(item);
                            });
                        }
                    }

                    else if (pou_type.substr(0, 3) === "VAR") {
                        /* still need to separate variable block attributes from first var, iterate over multiple variables 
                            in a single declaration, possibly handle STRUCT|UNION and enum inline. */
                        const rgx_var_attr = /(?!$)((?:(?:\b(?:ABSTRACT|(CONSTANT)|RETAIN|PERSISTENT|PUBLIC|PRIVATE|PROTECTED|INTERNAL|FINAL)\b)?(?:\/\/.*(?=\r?\n|$)|(["'])(?:(?!\2)(?:\$\2|[\s\S]))*(?:\2|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s])*?)*)(?:$|\b(?=(?:(?:END_)?(?:ACTION|METHOD|STRUCT|UNION|(?<=END_)VAR|(?<!END)VAR(?:_(?:INPUT|OUTPUT|IN_OUT|INST|TEMP|STAT|GLOBAL|ACCESS|EXTERNAL|CONFIG))?)|EXTENDS|IMPLEMENTS|PROPERTY|USES|IF|CASE|WHILE|REPEAT|DO|FOR|RETURN|EXIT|CONTINUE|AT|ANY|BIT|BOOL|BYTE|[DL]?WORD|U?[SDL]?INT|L?REAL|L?TIME(?:_OF_DAY)?|L?TOD|L?DT|L?DATE(?:_AND_TIME)?|W?STRING|W?CHAR|ARRAY)\b)|(?=\S))/iy
                        /* Captures break-down
                            [1] POU attributes prior to first sub-item
                        */
                        let var_attr = pous[5].match(rgx_var_attr);
                        let var_attr_constant = var_attr && var_attr[1].match(/(?:\/\/.*(?=\r?\n|$)|(["'])(?:(?!\1)(?:\$\1|[\s\S]))*(?:\1|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?(?:$|\b(CONSTANT)\b)/iy) || null;
                        let isConstantVar = var_attr_constant && var_attr_constant[2] !== undefined || false;
                        const varSymbol = VarBlockDesc.find(varDes => varDes.varKeyword === pou_type)
                            || { varKeyword: pou_type, desc: "<unknown>" } as IVarBlockDesc;
                        let symbol = new vscode.DocumentSymbol(
                            pou_type, varSymbol.desc, vscode.SymbolKind.File, pou_full_range, pou_reveal_range);
                        const var_attr_offset = var_attr && var_attr[0] !== undefined ? var_attr[0].length : 0;
                        symbol.children = listVariables(pous[5].substr(var_attr_offset), pou_content_offset + var_attr_offset, false, isConstantVar);
                        symbols.push(symbol);
                    }

                    else {
                        const rgx_pou_name = /((?:(?:\b(?:ABSTRACT|CONSTANT|RETAIN|PERSISTENT|PUBLIC|PRIVATE|PROTECTED|INTERNAL|FINAL)\b)?(?:\/\/.*(?=\r?\n|$)|(["'])(?:(?!\2)(?:\$\2|[\s\S]))*(?:\2|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s])*?)*)(?:$|\b(?=(?:(?:END_)?(?:ACTION|METHOD|STRUCT|UNION|(?<=END_)VAR|(?<!END)VAR(?:_(?:INPUT|OUTPUT|IN_OUT|INST|TEMP|STAT|GLOBAL|ACCESS|EXTERNAL|CONFIG))?)|EXTENDS|IMPLEMENTS|PROPERTY|USES|IF|CASE|WHILE|REPEAT|DO|FOR|RETURN|EXIT|CONTINUE|AT|ANY|BIT|BOOL|BYTE|[DL]?WORD|U?[SDL]?INT|L?REAL|L?TIME(?:_OF_DAY)?|L?TOD|L?DT|L?DATE(?:_AND_TIME)?|W?STRING|W?CHAR|ARRAY)\b)|\b([A-Z_](?:[A-Z0-9]|(?<!_)_)*)\b|(?=\S))/iy
                        /* Captures break-down
                            [1] POU attributes prior to name
                            [3] POU Name
                        */
                        let pou_name = pous[5].match(rgx_pou_name);
                        const pouBlockSymbol = PouBlockDesc.find(blockDes => blockDes.PouBlock === pou_type)
                            || { PouBlock: pou_type, SymType: vscode.SymbolKind.Null, Desc: "<unknown>" } as IPouBlockDesc;
                        let symbol = new vscode.DocumentSymbol(
                            unNamedItem(pou_name && pou_name[3] || undefined), pouBlockSymbol.Desc,
                            pouBlockSymbol.SymType,
                            pou_full_range, pou_reveal_range
                        );
                        const pou_name_offset = pou_name && pou_name[0] !== undefined ? pou_name[0].length : 0;
                        symbol.children = recursePouSymbols(pous[5].substr(pou_name_offset), pou_content_offset + pou_name_offset);
                        symbols.push(symbol);
                    }
                }

            }
            return symbols;

            function listVariables(text: string, offset: number, isType: Boolean, isConstantVar?: Boolean): vscode.DocumentSymbol[] {
                // break down variable / type / structure / enum lists
                let items: vscode.DocumentSymbol[] = [];
                let rgx_struct = /(?!$)((?:\/\/.*(?=\r?\n|$)|(["'])(?:(?!\2)(?:\$\2|[\s\S]))*(?:\2|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s])*?)(?:$|((?:(?:$|\b[A-Z_](?:[A-Z0-9]|(?<!_)_)*\b|,)(?:\/\/.*(?=\r?\n|$)|(["'])(?:(?!\4)(?:\$\4|[\s\S]))*(?:\4|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s])*?)*)(:(?!=)(?:\/\/.*(?=\r?\n|$)|(["'])(?:(?!\6)(?:\$\6|[\s\S]))*(?:\6|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?)(?:$|\b(STRUCT|UNION)\b((?:\/\/.*(?=\r?\n|$)|(["'])(?:(?!\9)(?:\$\9|[\s\S]))*(?:\9|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?)\bEND_\7\b|(?:\((?!\*)((?:\/\/.*(?=\r?\n|$)|(["'])(?:(?!\11)(?:\$\11|[\s\S]))*(?:\11|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?)(?:$|\)(?:\/\/.*(?=\r?\n|$)|(["'])(?:(?!\12)(?:\$\12|[\s\S]))*(?:\12|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?))?(?:\b([A-Z_](?:[A-Z0-9]|(?<!_)_)*)\b((?:\/\/.*(?=\r?\n|$)|(["'])(?:(?!\15)(?:\$\15|[\s\S]))*(?:\15|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?))?(?:;|$))(?:\/\/.*(?=\r?\n|$)|(["'])(?:(?!\16)(?:\$\16|[\s\S]))*(?:\16|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s])*?(?:$|(?=\r?\n\s*?\r?\n|\s*(?:$|(?!\/\/|\/\*|\(\*)\S))))/iy;
                /* Captures break-down
                    [1] - header before var|type name
                    [3] - var|type name(s) (CSV, potentially empty)
                    [5] - separation
                    [7] - STRUCT | UNION
                    [8] - struct constructor
                    [10] - enumeration constructor
                    [13] - var|enum base type
                    [14] - var|enum type expression
                    */
                let ms: RegExpExecArray | null;
                while ((ms = rgx_struct.exec(text)) !== null) {
                    if (ms[3] !== undefined) {
                        let itemChildren: vscode.DocumentSymbol[] = [];
                        const struct_offset = offset + ms.index + ms[1].length;
                        const isEnum = ms[10] !== undefined;
                        if (!isEnum) {
                            if (ms[8] !== undefined) {
                                // need to recurse through elements in a STRUCT or UNION
                                const content_offset = struct_offset + ms[3].length + ms[5].length + ms[7].length;
                                itemChildren = listVariables(ms[8], content_offset, false);
                            }
                        }

                        else {
                            const content_offset = struct_offset + ms[3].length + ms[5].length + 1;
                            const rgx_enums = /(?!$)((?:\/\/.*(?=\r?\n|$)|(["'])(?:(?!\2)(?:\$\2|[\s\S]))*(?:\2|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?)(?:$|,|(?:\b(?=(?:EXTENDS|IMPLEMENTS|PROPERTY|USES|IF|CASE|WHILE|REPEAT|DO|FOR|RETURN|EXIT|CONTINUE|AT|ANY|BIT|BOOL|BYTE|[DL]?WORD|U?[SDL]?INT|L?REAL|L?TIME(?:_OF_DAY)?|L?TOD|L?DT|L?DATE(?:_AND_TIME)?|W?STRING|W?CHAR|ARRAY)\b)|\b([A-Z_](?:[A-Z0-9]|(?<!_)_)*)\b)(?:\/\/.*(?=\r?\n|$)|(["'])(?:(?!\4)(?:\$\4|[\s\S]))*(?:\4|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?(?:$|,)(?:\/\/.*(?=\r?\n|$)|(["'])(?:(?!\5)(?:\$\5|[\s\S]))*(?:\5|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?(?:$|(?=\r?\n\s*?\r?\n|\s*(?:$|(?!\/\/|\/\*|\(\*)\S))))/iy;
                            /* Captures break-down
                                [1] - leader preceeding first member name
                                [3] - enum member name
                            */
                            let enums: RegExpExecArray | null;
                            while ((enums = rgx_enums.exec(ms[10])) !== null) {
                                const enums_offset = content_offset + enums.index + enums[1].length;
                                const enums_pos = document.positionAt(enums_offset);
                                itemChildren.push(new vscode.DocumentSymbol(
                                    unNamedItem(enums[3]), 'Enumerator',
                                    vscode.SymbolKind.EnumMember,
                                    new vscode.Range(enums_pos, document.positionAt(content_offset + enums.index + enums[0].length)),
                                    new vscode.Range(enums_pos, document.positionAt(enums_offset + (enums[3] !== undefined ? enums[3].length : 0)))
                                ));
                            };
                        }

                        // create a separate item for each variable/type identifier defined here
                        separateVarIdents(ms[3]).forEach( varIdent => {
                            const varIdent_offset = struct_offset + varIdent.startOffset;
                            const struct_pos = document.positionAt(varIdent_offset);
                            let item = new vscode.DocumentSymbol(
                                (ms![13] !== undefined) ? (unNamedItem(varIdent.varIdent) + " (" + ms![13] + ")") : unNamedItem(varIdent.varIdent),
                                isType ? (isEnum ? 'Enumeration' : ((ms![7] === undefined || ms![7].toUpperCase() === 'STRUCT') ? 'Structure' : 'Union')) : ((isConstantVar !== undefined ? isConstantVar : false) ? 'Constant' : 'Variable'),
                                isType ? (isEnum ? vscode.SymbolKind.Enum : vscode.SymbolKind.Struct) : ((isConstantVar !== undefined ? isConstantVar : false) ? vscode.SymbolKind.Constant : vscode.SymbolKind.Variable),
                                new vscode.Range(struct_pos, document.positionAt(offset + ms!.index + ms![0].length)),
                                new vscode.Range(struct_pos, document.positionAt(varIdent_offset + (varIdent.varIdent !== undefined ? varIdent.varIdent.length : 0)))
                            );
                            item.children = itemChildren;
                            items.push(item);
                        });
                    }
                }
                return items;

                type TVarIdentReturn = { varIdent: string, startOffset: number, endOffset: number};

                function separateVarIdents(text: string):TVarIdentReturn[] {
                    let rgx_varIdent = /(?!$)((?:\/\/.*(?=\r?\n|$)|(["'])(?:(?!\2)(?:\$\2|[\s\S]))*(?:\2|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?)(?:$|,|(?:\b(?=(?:EXTENDS|IMPLEMENTS|PROPERTY|USES|IF|CASE|WHILE|REPEAT|DO|FOR|RETURN|EXIT|CONTINUE|AT|ANY|BIT|BOOL|BYTE|[DL]?WORD|U?[SDL]?INT|L?REAL|L?TIME(?:_OF_DAY)?|L?TOD|L?DT|L?DATE(?:_AND_TIME)?|W?STRING|W?CHAR|ARRAY)\b)|\b([A-Z_](?:[A-Z0-9]|(?<!_)_)*)\b)(?:\/\/.*(?=\r?\n|$)|(["'])(?:(?!\4)(?:\$\4|[\s\S]))*(?:\4|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?(?:$|,)(?:\/\/.*(?=\r?\n|$)|(["'])(?:(?!\5)(?:\$\5|[\s\S]))*(?:\5|$)|\(\*[\s\S]*?(?:\*\)|$)|\/\*[\s\S]*?(?:\*\/|$)|[\s\S])*?(?:$|(?=\r?\n\s*?\r?\n|\s*(?:$|(?!\/\/|\/\*|\(\*)\S))))/iy
                    let varIdents: TVarIdentReturn[] = [];
                    let vars: RegExpExecArray | null;
                    while ((vars = rgx_varIdent.exec(text)) !== null) {
                        varIdents.push( 
                            {varIdent: vars[3], 
                            startOffset: vars.index + (vars[1] !== undefined ? vars[1].length: 0),
                            endOffset: vars.index + vars[0].length})
                    }

                    return varIdents;
                }
            }

            function unNamedItem(name: string | undefined): string {
                return name !== undefined ? name : "<unnamed>";
            }
        }
    }
}