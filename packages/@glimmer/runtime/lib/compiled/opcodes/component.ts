import { OpcodeJSON, UpdatingOpcode } from '../../opcodes';
import { Assert } from './vm';
import { UpdatingVM } from '../../vm';
import ARGS, { IArguments } from '../../vm/arguments';
import { Component, ComponentManager, ComponentDefinition } from '../../component/interfaces';
import { DynamicScope } from '../../environment';
import Bounds from '../../bounds';
import { APPEND_OPCODES, Op as Op } from '../../opcodes';
import { ComponentElementOperations } from './dom';
import { Opaque } from '@glimmer/util';
import {
  CONSTANT_TAG,
  ReferenceCache,
  VersionedPathReference,
  Tag,
  combine,
  isConst
} from '@glimmer/reference';

APPEND_OPCODES.add(Op.PushComponentManager, (vm, { op1: _definition }) => {
  let definition = vm.constants.getOther<ComponentDefinition<Opaque>>(_definition);
  let stack = vm.evalStack;

  stack.push(definition);
  stack.push(definition.manager);
});

APPEND_OPCODES.add(Op.PushDynamicComponentManager, (vm, { op1: local }) => {
  let reference = vm.getLocal<VersionedPathReference<ComponentDefinition<Opaque>>>(local);
  let cache = isConst(reference) ? undefined : new ReferenceCache<ComponentDefinition<Opaque>>(reference);
  let definition = cache ? cache.peek() : reference.value();

  vm.evalStack.push(definition);
  vm.evalStack.push(definition.manager);

  if (cache) {
    vm.updateWith(new Assert(cache));
  }
});

interface InitialComponentState<T> {
  definition: ComponentDefinition<T>;
  manager: ComponentManager<T>;
  component: null;
}

export interface ComponentState<T> {
  definition: ComponentDefinition<T>;
  manager: ComponentManager<T>;
  component: T;
}

APPEND_OPCODES.add(Op.SetComponentState, (vm, { op1: local }) => {
  let stack = vm.evalStack;

  let manager = stack.pop();
  let definition = stack.pop();

  vm.setLocal(local, { definition, manager, component: null });
});

APPEND_OPCODES.add(Op.PushArgs, (vm, { op1: positional, op2: _names, op3: synthetic }) => {
  let stack = vm.evalStack;
  let names = vm.constants.getOther<string[]>(_names);
  ARGS.setup(stack, positional, names, !!synthetic);
  stack.push(ARGS);
});

APPEND_OPCODES.add(Op.CreateComponent, (vm, { op1: flags, op2: _state }) => {
  let definition, manager;
  let args = vm.evalStack.pop<IArguments>();
  let state = { definition, manager } = vm.getLocal<InitialComponentState<Opaque>>(_state);

  let hasDefaultBlock = flags & 0b01;

  let component = manager.create(vm.env, definition, args, vm.dynamicScope(), vm.getSelf(), !!hasDefaultBlock);
  (state as ComponentState<typeof component>).component = component;
});

APPEND_OPCODES.add(Op.RegisterComponentDestructor, (vm, { op1: _state }) => {
  let { manager, component } = vm.getLocal<ComponentState<Opaque>>(_state);

  let destructor = manager.getDestructor(component);
  if (destructor) vm.newDestroyable(destructor);
});

APPEND_OPCODES.add(Op.BeginComponentTransaction, vm => {
  vm.beginCacheGroup();
  vm.stack().pushSimpleBlock();
});

APPEND_OPCODES.add(Op.PushComponentOperations, vm => {
  vm.evalStack.push(new ComponentElementOperations(vm.env));
});

APPEND_OPCODES.add(Op.DidCreateElement, (vm, { op1: _state }) => {
  let { manager, component } = vm.getLocal<ComponentState<Opaque>>(_state);

  let action = 'DidCreateElementOpcode#evaluate';
  manager.didCreateElement(component, vm.stack().expectConstructing(action), vm.stack().expectOperations(action));
});

APPEND_OPCODES.add(Op.GetComponentSelf, (vm, { op1: _state }) => {
  let state = vm.getLocal<ComponentState<Opaque>>(_state);
  vm.evalStack.push(state.manager.getSelf(state.component));
});

APPEND_OPCODES.add(Op.GetComponentLayout, (vm, { op1: _state }) => {
  let { manager, definition, component } = vm.getLocal<ComponentState<Opaque>>(_state);
  vm.evalStack.push(manager.layoutFor(definition, component, vm.env));
});

APPEND_OPCODES.add(Op.DidRenderLayout, (vm, { op1: _state }) => {
  let { manager, component } = vm.getLocal<ComponentState<Opaque>>(_state);
  let bounds = vm.stack().popBlock();

  manager.didRenderLayout(component, bounds);

  vm.env.didCreate(component, manager);

  vm.updateWith(new DidUpdateLayoutOpcode(manager, component, bounds));
});

APPEND_OPCODES.add(Op.CommitComponentTransaction, vm => vm.commitCacheGroup());

export class UpdateComponentOpcode extends UpdatingOpcode {
  public type = "update-component";

  constructor(
    tag: Tag,
    private name: string,
    private component: Component,
    private manager: ComponentManager<Component>,
    private dynamicScope: DynamicScope,
  ) {
    super();

    let componentTag = manager.getTag(component);

    if (componentTag) {
      this.tag = combine([tag, componentTag]);
    } else {
      this.tag = tag;
    }
  }

  evaluate(_vm: UpdatingVM) {
    let { component, manager, dynamicScope } = this;

    manager.update(component, dynamicScope);
  }

  toJSON(): OpcodeJSON {
    return {
      guid: this._guid,
      type: this.type,
      args: [JSON.stringify(this.name)]
    };
  }
}

export class DidUpdateLayoutOpcode extends UpdatingOpcode {
  public type = "did-update-layout";
  public tag: Tag = CONSTANT_TAG;

  constructor(
    private manager: ComponentManager<Component>,
    private component: Component,
    private bounds: Bounds
  ) {
    super();
  }

  evaluate(vm: UpdatingVM) {
    let { manager, component, bounds } = this;

    manager.didUpdateLayout(component, bounds);

    vm.env.didUpdate(component, manager);
  }
}
