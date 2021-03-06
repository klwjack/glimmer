import b from "../builders";
import { appendChild, isLiteral, printLiteral } from "../utils";
import * as AST from '../types/nodes';
import { Parser, Tag, Attribute } from '../parser';
import { Option } from '@glimmer/interfaces';

export abstract class HandlebarsNodeVisitors extends Parser {
  abstract appendToCommentData(s: string): void;
  abstract beginAttributeValue(quoted: boolean): void;
  abstract finishAttributeValue(): void;

  Program(program: hbs.AST.Program): AST.Program {
    let body: AST.Statement[] = [];
    let node = b.program(body, program.blockParams, program.loc);
    let i, l = program.body.length;

    this.elementStack.push(node);

    if (l === 0) { return this.elementStack.pop() as AST.Program; }

    for (i = 0; i < l; i++) {
      this.acceptNode(program.body[i]);
    }

    // Ensure that that the element stack is balanced properly.
    let poppedNode = this.elementStack.pop();
    if (poppedNode !== node) {
      throw new Error("Unclosed element `" + (poppedNode as AST.ElementNode).tag + "` (on line " + (poppedNode as AST.ElementNode).loc!.start.line + ").");
    }

    return node;
  }

  BlockStatement(block: hbs.AST.BlockStatement) {
    // delete block.inverseStrip;
    // delete block.openString;
    // delete block.closeStrip;

    if (this.tokenizer['state'] === 'comment') {
      this.appendToCommentData(this.sourceForNode(block));
      return;
    }

    if (this.tokenizer['state'] !== 'comment' && this.tokenizer['state'] !== 'data' && this.tokenizer['state'] !== 'beforeData') {
      throw new Error("A block may only be used inside an HTML element or another block.");
    }

    let { path, params, hash } = acceptCallNodes(this, block);
    let program = this.Program(block.program);
    let inverse = block.inverse ? this.Program(block.inverse) : null;

    let node = b.block(path, params, hash, program, inverse, block.loc);
    let parentProgram = this.currentElement();
    appendChild(parentProgram, node);
  }

  MustacheStatement(rawMustache: hbs.AST.MustacheStatement) {
    let { tokenizer } = this;

    if (tokenizer['state'] === 'comment') {
      this.appendToCommentData(this.sourceForNode(rawMustache));
      return;
    }

    let mustache: AST.MustacheStatement;
    let { escaped, loc } = rawMustache;

    if (rawMustache.path.type.match(/Literal$/)) {
      mustache = {
        type: 'MustacheStatement',
        path: this.acceptNode<AST.Literal>(rawMustache.path),
        params: [],
        hash: b.hash(),
        escaped,
        loc
      };
    } else {
      let { path, params, hash } = acceptCallNodes(this, rawMustache as hbs.AST.MustacheStatement & { path: hbs.AST.PathExpression });
      mustache = b.mustache(path, params, hash, !escaped, loc);
    }

    switch (tokenizer.state) {
      // Tag helpers
      case "tagName":
        addElementModifier(this.currentStartTag, mustache);
        tokenizer.state = "beforeAttributeName";
        break;
      case "beforeAttributeName":
        addElementModifier(this.currentStartTag, mustache);
        break;
      case "attributeName":
      case "afterAttributeName":
        this.beginAttributeValue(false);
        this.finishAttributeValue();
        addElementModifier(this.currentStartTag, mustache);
        tokenizer.state = "beforeAttributeName";
        break;
      case "afterAttributeValueQuoted":
        addElementModifier(this.currentStartTag, mustache);
        tokenizer.state = "beforeAttributeName";
        break;

      // Attribute values
      case "beforeAttributeValue":
        appendDynamicAttributeValuePart(this.currentAttribute!, mustache);
        tokenizer.state = 'attributeValueUnquoted';
        break;
      case "attributeValueDoubleQuoted":
      case "attributeValueSingleQuoted":
      case "attributeValueUnquoted":
        appendDynamicAttributeValuePart(this.currentAttribute!, mustache);
        break;

      // TODO: Only append child when the tokenizer state makes
      // sense to do so, otherwise throw an error.
      default:
        appendChild(this.currentElement(), mustache);
    }

    return mustache;
  }

  ContentStatement(content: hbs.AST.ContentStatement) {
    updateTokenizerLocation(this.tokenizer, content);

    this.tokenizer.tokenizePart(content.value);
    this.tokenizer.flushData();
  }

  CommentStatement(rawComment: hbs.AST.CommentStatement): Option<AST.MustacheCommentStatement> {
    let { tokenizer } = this;

    if (tokenizer.state === 'comment') {
      this.appendToCommentData(this.sourceForNode(rawComment));
      return null;
    }

    let { value, loc } = rawComment;
    let comment = b.mustacheComment(value, loc);

    switch (tokenizer.state) {
      case "beforeAttributeName":
        this.currentStartTag.comments.push(comment);
        break;

      case 'beforeData':
      case 'data':
        appendChild(this.currentElement(), comment);
        break;

      default:
        throw new Error(`Using a Handlebars comment when in the \`${tokenizer.state}\` state is not supported: "${comment.value}" on line ${loc.start.line}:${loc.start.column}`);
    }

    return comment;
  }

  PartialStatement(partial: hbs.AST.PartialStatement) {
    let { loc } = partial;

    throw new Error(`Handlebars partials are not supported: "${this.sourceForNode(partial, partial.name)}" at L${loc.start.line}:C${loc.start.column}`);
  }

  PartialBlockStatement(partialBlock: hbs.AST.PartialBlockStatement) {
    let { loc } = partialBlock;

    throw new Error(`Handlebars partial blocks are not supported: "${this.sourceForNode(partialBlock, partialBlock.name)}" at L${loc.start.line}:C${loc.start.column}`);
  }

  Decorator(decorator: hbs.AST.Decorator) {
    let { loc } = decorator;

    throw new Error(`Handlebars decorators are not supported: "${this.sourceForNode(decorator, decorator.path)}" at L${loc.start.line}:C${loc.start.column}`);
  }

  DecoratorBlock(decoratorBlock: hbs.AST.DecoratorBlock) {
    let { loc } = decoratorBlock;

    throw new Error(`Handlebars decorator blocks are not supported: "${this.sourceForNode(decoratorBlock, decoratorBlock.path)}" at L${loc.start.line}:C${loc.start.column}`);
  }

  SubExpression(sexpr: hbs.AST.SubExpression): AST.SubExpression {
    let { path, params, hash } = acceptCallNodes(this, sexpr);
    return b.sexpr(path, params, hash, sexpr.loc);
  }

  PathExpression(path: hbs.AST.PathExpression): AST.PathExpression {
    let { original, loc } = path;
    let parts: string[];

    if (original.indexOf('/') !== -1) {
      // TODO add a SyntaxError with loc info
      if (original.slice(0, 2) === './') {
        throw new Error(`Using "./" is not supported in Glimmer and unnecessary: "${path.original}" on line ${loc.start.line}.`);
      }
      if (original.slice(0, 3) === '../') {
        throw new Error(`Changing context using "../" is not supported in Glimmer: "${path.original}" on line ${loc.start.line}.`);
      }
      if (original.indexOf('.') !== -1) {
        throw new Error(`Mixing '.' and '/' in paths is not supported in Glimmer; use only '.' to separate property paths: "${path.original}" on line ${loc.start.line}.`);
      }
      parts = [ path.parts.join('/') ];
    } else {
      parts = path.parts;
    }

    let thisHead = false;

    // This is to fix a bug in the Handlebars AST where the path expressions in
    // `{{this.foo}}` (and similarly `{{foo-bar this.foo named=this.foo}}` etc)
    // are simply turned into `{{foo}}`. The fix is to push it back onto the
    // parts array and let the runtime see the difference. However, we cannot
    // simply use the string `this` as it means literally the property called
    // "this" in the current context (it can be expressed in the syntax as
    // `{{[this]}}`, where the square bracket are generally for this kind of
    // escaping – such as `{{foo.["bar.baz"]}}` would mean lookup a property
    // named literally "bar.baz" on `this.foo`). By convention, we use `null`
    // for this purpose.
    if (original.match(/^this(\..+)?$/)) {
      thisHead = true;
    }

    return {
      type: 'PathExpression',
      original: path.original,
      this: thisHead,
      parts,
      data: path.data,
      loc: path.loc
    };
  }

  Hash(hash: hbs.AST.Hash): AST.Hash {
    let pairs: AST.HashPair[] = [];

    for (let i = 0; i < hash.pairs.length; i++) {
      let pair = hash.pairs[i];
      pairs.push(b.pair(pair.key, this.acceptNode<AST.Expression>(pair.value), pair.loc));
    }

    return b.hash(pairs, hash.loc);
  }

  StringLiteral(string: hbs.AST.StringLiteral) {
    return b.literal('StringLiteral', string.value, string.loc);
  }

  BooleanLiteral(boolean: hbs.AST.BooleanLiteral) {
    return b.literal('BooleanLiteral', boolean.value, boolean.loc);
  }

  NumberLiteral(number: hbs.AST.NumberLiteral) {
    return b.literal('NumberLiteral', number.value, number.loc);
  }

  UndefinedLiteral(undef: hbs.AST.UndefinedLiteral) {
    return b.literal('UndefinedLiteral', undefined, undef.loc);
  }

  NullLiteral(nul: hbs.AST.NullLiteral) {
    return b.literal('NullLiteral', null, nul.loc);
  }
}

function calculateRightStrippedOffsets(original: string, value: string) {
  if (value === '') {
    // if it is empty, just return the count of newlines
    // in original
    return {
      lines: original.split("\n").length - 1,
      columns: 0
    };
  }

  // otherwise, return the number of newlines prior to
  // `value`
  let difference = original.split(value)[0];
  let lines = difference.split(/\n/);
  let lineCount = lines.length - 1;

  return {
    lines: lineCount,
    columns: lines[lineCount].length
  };
}

function updateTokenizerLocation(tokenizer: Parser['tokenizer'], content: hbs.AST.ContentStatement) {
  let line = content.loc.start.line;
  let column = content.loc.start.column;

  let offsets = calculateRightStrippedOffsets(content.original as any as string, content.value);

  line = line + offsets.lines;
  if (offsets.lines) {
    column = offsets.columns;
  } else {
    column = column + offsets.columns;
  }

  tokenizer.line = line;
  tokenizer.column = column;
}

function acceptCallNodes(compiler: HandlebarsNodeVisitors, node: { path: hbs.AST.PathExpression, params: hbs.AST.Expression[], hash: hbs.AST.Hash }): { path: AST.PathExpression, params: AST.Expression[], hash: AST.Hash } {
  let path = compiler.PathExpression(node.path);

  let params = node.params ? node.params.map(e => compiler.acceptNode<AST.Expression>(e)) : [];
  let hash = node.hash ? compiler.Hash(node.hash) : b.hash();

  return { path, params, hash };
}

function addElementModifier(element: Tag<'StartTag'>, mustache: AST.MustacheStatement) {
  let { path, params, hash, loc } = mustache;

  if (isLiteral(path)) {
    let modifier = `{{${printLiteral(path)}}}`;
    let tag = `<${element.name} ... ${modifier} ...`;

    throw new Error(`In ${tag}, ${modifier} is not a valid modifier: "${path.original}" on line ${loc && loc.start.line}.`);
  }

  let modifier = b.elementModifier(path, params, hash, loc);
  element.modifiers.push(modifier);
}

function appendDynamicAttributeValuePart(attribute: Attribute, part: AST.MustacheStatement) {
  attribute.isDynamic = true;
  attribute.parts.push(part);
}
