// Copyright 2018 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as DataGrid from '../data_grid/data_grid.js';
import * as Host from '../host/host.js';
import * as ProtocolClient from '../protocol_client/protocol_client.js';
import * as SDK from '../sdk/sdk.js';
import * as SourceFrame from '../source_frame/source_frame.js';
import * as TextUtils from '../text_utils/text_utils.js';
import * as UI from '../ui/ui.js';

export class ProtocolMonitorImpl extends UI.Widget.VBox {
  constructor() {
    super(true);
    /**
     * @type {!Array<!ProtocolNode>}
     */
    this._nodes = [];
    this._started = false;
    this._startTime = 0;
    /**
     * @type {!Map<number, !ProtocolNode>}
     */
    this._nodeForId = new Map();
    /**
     * @param {!ProtocolNode} node
     */
    this._filter = node => true;
    /**
     * @type {!Array<!ProtocolColumnConfig>}
     */
    this._columns = [
      {id: 'method', title: ls`Method`, visible: true, sortable: true, hideable: false, weight: 60},
      {id: 'direction', title: ls`Direction`, visible: false, sortable: true, hideable: true, weight: 30},
      {id: 'request', title: ls`Request`, visible: true, sortable: false, hideable: true, weight: 60},
      {id: 'response', title: ls`Response`, visible: true, sortable: false, hideable: true, weight: 60},
      {id: 'timestamp', title: ls`Timestamp`, visible: false, sortable: true, hideable: true, weight: 30},
      {id: 'target', title: ls`Target`, visible: false, sortable: true, hideable: true, weight: 30}
    ];

    this.registerRequiredCSS('protocol_monitor/protocolMonitor.css', {enableLegacyPatching: true});
    const topToolbar = new UI.Toolbar.Toolbar('protocol-monitor-toolbar', this.contentElement);
    const recordButton =
        new UI.Toolbar.ToolbarToggle(ls`Record`, 'largeicon-start-recording', 'largeicon-stop-recording');
    recordButton.addEventListener(UI.Toolbar.ToolbarButton.Events.Click, () => {
      recordButton.setToggled(!recordButton.toggled());
      this._setRecording(recordButton.toggled());
    });
    recordButton.setToggleWithRedColor(true);
    topToolbar.appendToolbarItem(recordButton);
    recordButton.setToggled(true);

    const clearButton = new UI.Toolbar.ToolbarButton(ls`Clear all`, 'largeicon-clear');
    clearButton.addEventListener(UI.Toolbar.ToolbarButton.Events.Click, () => {
      this._dataGrid.rootNode().removeChildren();
      this._nodes = [];
      this._nodeForId.clear();
    });
    topToolbar.appendToolbarItem(clearButton);

    const split = new UI.SplitWidget.SplitWidget(true, true, 'protocol-monitor-panel-split', 250);
    split.show(this.contentElement);
    this._dataGrid = new DataGrid.SortableDataGrid.SortableDataGrid({
      displayName: ls`Protocol Monitor`,
      columns: this._columns.map(column => ({
                                   id: column.id,
                                   title: column.title,
                                   sortable: column.sortable,
                                   weight: column.weight,
                                   titleDOMFragment: undefined,
                                   sort: undefined,
                                   align: undefined,
                                   width: undefined,
                                   fixedWidth: undefined,
                                   editable: undefined,
                                   nonSelectable: undefined,
                                   longText: undefined,
                                   disclosure: undefined,
                                   allowInSortByEvenWhenHidden: undefined,
                                   dataType: undefined,
                                   defaultWeight: undefined,
                                 })),
      editCallback: undefined,
      deleteCallback: undefined,
      refreshCallback: undefined,
    });
    this._dataGrid.element.style.flex = '1';
    this._infoWidget = new InfoWidget();
    split.setMainWidget(this._dataGrid.asWidget());
    split.setSidebarWidget(this._infoWidget);
    this._dataGrid.addEventListener(
        DataGrid.DataGrid.Events.SelectedNode, event => this._infoWidget.render(event.data.data));
    this._dataGrid.addEventListener(DataGrid.DataGrid.Events.DeselectedNode, event => this._infoWidget.render(null));
    this._dataGrid.setHeaderContextMenuCallback(this._innerHeaderContextMenu.bind(this));
    this._dataGrid.setRowContextMenuCallback(this._innerRowContextMenu.bind(this));


    this._dataGrid.addEventListener(DataGrid.DataGrid.Events.SortingChanged, this._sortDataGrid.bind(this));
    this._dataGrid.setStickToBottom(true);
    this._dataGrid.sortNodes(
        DataGrid.SortableDataGrid.SortableDataGrid.NumericComparator.bind(null, 'timestamp'), false);
    this._updateColumnVisibility();

    const keys = ['method', 'request', 'response', 'direction'];
    this._filterParser = new TextUtils.TextUtils.FilterParser(keys);
    this._suggestionBuilder = new UI.FilterSuggestionBuilder.FilterSuggestionBuilder(keys);

    this._textFilterUI = new UI.Toolbar.ToolbarInput(
        ls`Filter`, '', 1, .2, '', this._suggestionBuilder.completions.bind(this._suggestionBuilder));
    this._textFilterUI.addEventListener(UI.Toolbar.ToolbarInput.Event.TextChanged, event => {
      const query = /** @type {string} */ (event.data);
      const filters = this._filterParser.parse(query);
      /**
       * @param {!ProtocolNode} node
       */
      const filter = node => {
        for (const {key, text, negative} of filters) {
          if (!text) {
            continue;
          }
          const data = key ? node.data[key] : node.data;
          if (!data) {
            continue;
          }
          const found = JSON.stringify(data).toLowerCase().indexOf(text.toLowerCase()) !== -1;
          if (found === negative) {
            return false;
          }
        }
        return true;
      };
      this._filter = filter;
      this._filterNodes();
    });
    topToolbar.appendToolbarItem(this._textFilterUI);
  }

  _filterNodes() {
    for (const node of this._nodes) {
      if (this._filter(node)) {
        if (!node.parent) {
          this._dataGrid.insertChild(node);
        }
      } else {
        node.remove();
      }
    }
  }

  /**
   * @param {!UI.ContextMenu.SubMenu} contextMenu
   */
  _innerHeaderContextMenu(contextMenu) {
    const columnConfigs = this._columns.filter(columnConfig => columnConfig.hideable);
    for (const columnConfig of columnConfigs) {
      contextMenu.headerSection().appendCheckboxItem(
          columnConfig.title, this._toggleColumnVisibility.bind(this, columnConfig), columnConfig.visible);
    }
  }

  /**
   * @param {!UI.ContextMenu.ContextMenu} contextMenu
   * @param {!DataGrid.DataGrid.DataGridNode<!DataGrid.ViewportDataGrid.ViewportDataGridNode<!DataGrid.SortableDataGrid.SortableDataGridNode<!ProtocolNode>>>} node
   */
  _innerRowContextMenu(contextMenu, node) {
    contextMenu.defaultSection().appendItem(ls`Filter`, () => {
      this._textFilterUI.setValue(`method:${node.data.method}`, true);
    });
    contextMenu.defaultSection().appendItem(ls`Documentation`, () => {
      const [domain, method] = node.data.method.split('.');
      const type = node.data.direction === 'sent' ? 'method' : 'event';
      Host.InspectorFrontendHost.InspectorFrontendHostInstance.openInNewTab(
          `https://chromedevtools.github.io/devtools-protocol/tot/${domain}#${type}-${method}`);
    });
  }

  /**
   * @param {!ProtocolColumnConfig} columnConfig
   */
  _toggleColumnVisibility(columnConfig) {
    columnConfig.visible = !columnConfig.visible;
    this._updateColumnVisibility();
  }

  _updateColumnVisibility() {
    const visibleColumns = new Set();
    for (const columnConfig of this._columns) {
      if (columnConfig.visible) {
        visibleColumns.add(columnConfig.id);
      }
    }
    this._dataGrid.setColumnsVisiblity(visibleColumns);
  }

  _sortDataGrid() {
    const sortColumnId = this._dataGrid.sortColumnId();
    if (!sortColumnId) {
      return;
    }

    let columnIsNumeric = true;
    switch (sortColumnId) {
      case 'method':
      case 'direction':
        columnIsNumeric = false;
        break;
    }


    const comparator = columnIsNumeric ? DataGrid.SortableDataGrid.SortableDataGrid.NumericComparator :
                                         DataGrid.SortableDataGrid.SortableDataGrid.StringComparator;
    this._dataGrid.sortNodes(comparator.bind(null, sortColumnId), !this._dataGrid.isSortOrderAscending());
  }

  /**
   * @override
   */
  wasShown() {
    if (this._started) {
      return;
    }
    this._started = true;
    this._startTime = Date.now();
    this._setRecording(true);
  }

  /**
   * @param {boolean} recording
   */
  _setRecording(recording) {
    const test = ProtocolClient.InspectorBackend.test;
    if (recording) {
      // TODO: TS thinks that properties are read-only because
      // in TS test is defined as a namespace.
      // @ts-ignore
      test.onMessageSent = this._messageSent.bind(this);
      // @ts-ignore
      test.onMessageReceived = this._messageReceived.bind(this);
    } else {
      // @ts-ignore
      test.onMessageSent = null;
      // @ts-ignore
      test.onMessageReceived = null;
    }
  }

  /**
   * @param {?SDK.SDKModel.Target} target
   * @return {string}
   */
  _targetToString(target) {
    if (!target) {
      return '';
    }
    return target.decorateLabel(
        `${target.name()} ${target === SDK.SDKModel.TargetManager.instance().mainTarget() ? '' : target.id()}`);
  }

  /**
   * @param {*} message
   * @param {?ProtocolClient.InspectorBackend.TargetBase} target
   */
  _messageReceived(message, target) {
    if ('id' in message) {
      const node = this._nodeForId.get(message.id);
      if (!node) {
        return;
      }
      node.data.response = message.result || message.error;
      node.hasError = !!message.error;
      node.refresh();
      if (this._dataGrid.selectedNode === node) {
        const data =
            /** @type {?{method: string, direction: string, request: ?Object, response: ?Object, timestamp: number}}*/ (
                node.data);
        this._infoWidget.render(data);
      }
      return;
    }

    const sdkTarget = /** @type {?SDK.SDKModel.Target} */ (target);
    const node = new ProtocolNode({
      method: message.method,
      direction: 'received',
      response: message.params,
      timestamp: Date.now() - this._startTime,
      request: '',
      target: this._targetToString(sdkTarget)
    });
    this._nodes.push(node);
    if (this._filter(node)) {
      this._dataGrid.insertChild(node);
    }
  }

  /**
   * @param {{domain: string, method: string, params: !Object, id: number}} message
   * @param {?ProtocolClient.InspectorBackend.TargetBase} target
   */
  _messageSent(message, target) {
    const sdkTarget = /** @type {?SDK.SDKModel.Target} */ (target);
    const node = new ProtocolNode({
      method: message.method,
      direction: 'sent',
      request: message.params,
      timestamp: Date.now() - this._startTime,
      response: '(pending)',
      id: message.id,
      target: this._targetToString(sdkTarget)
    });
    this._nodeForId.set(message.id, node);
    this._nodes.push(node);
    if (this._filter(node)) {
      this._dataGrid.insertChild(node);
    }
  }
}
/**
 * @extends {DataGrid.SortableDataGrid.SortableDataGridNode<ProtocolNode>}
 */
export class ProtocolNode extends DataGrid.SortableDataGrid.SortableDataGridNode {
  /**
   * @param {?Object.<string, *>=} data
   */
  constructor(data) {
    super(data);
    this.hasError = false;
  }

  /**
   * @override
   * @param {string} columnId
   * @return {!HTMLElement}
   */
  createCell(columnId) {
    const createSourceCell = () => {
      const cell = this.createTD(columnId);
      const obj = SDK.RemoteObject.RemoteObject.fromLocalObject(this.data[columnId]);
      cell.textContent = obj.description ? obj.description.trimEndWithMaxLength(50) : '';
      cell.classList.add('source-code');
      return cell;
    };
    switch (columnId) {
      case 'response': {
        if (!this.data[columnId] && this.data.direction === 'send') {
          const cell = this.createTD(columnId);
          cell.textContent = '(pending)';
          return cell;
        }
        return createSourceCell();
      }
      case 'request': {
        return createSourceCell();
      }
      case 'timestamp': {
        const cell = this.createTD(columnId);
        cell.textContent = ls`${this.data[columnId]} ms`;
        return cell;
      }
    }
    return super.createCell(columnId);
  }

  /**
   * @override
   */
  element() {
    const element = super.element();
    element.classList.toggle('protocol-message-sent', this.data.direction === 'sent');
    element.classList.toggle('protocol-message-received', this.data.direction !== 'sent');
    element.classList.toggle('error', this.hasError);
    return element;
  }
}

export class InfoWidget extends UI.Widget.VBox {
  constructor() {
    super();
    this._tabbedPane = new UI.TabbedPane.TabbedPane();
    this._tabbedPane.appendTab('request', 'Request', new UI.Widget.Widget());
    this._tabbedPane.appendTab('response', 'Response', new UI.Widget.Widget());
    this._tabbedPane.show(this.contentElement);
    this._tabbedPane.selectTab('response');
    this.render(null);
  }

  /**
   * @param {?{method: string, direction: string, request: ?Object, response: ?Object, timestamp: number}} data
   */
  render(data) {
    const requestEnabled = data && data.direction === 'sent';
    this._tabbedPane.setTabEnabled('request', !!requestEnabled);
    if (!data) {
      this._tabbedPane.changeTabView('request', new UI.EmptyWidget.EmptyWidget(ls`No message selected`));
      this._tabbedPane.changeTabView('response', new UI.EmptyWidget.EmptyWidget(ls`No message selected`));
      return;
    }
    if (!requestEnabled) {
      this._tabbedPane.selectTab('response');
    }

    this._tabbedPane.changeTabView('request', SourceFrame.JSONView.JSONView.createViewSync(data.request));
    this._tabbedPane.changeTabView('response', SourceFrame.JSONView.JSONView.createViewSync(data.response));
  }
}

/**
 * @typedef {{
 *  id: string,
 *  title: string,
 *  visible: boolean,
 *  sortable: boolean,
 *  hideable: boolean,
 *  weight: number,
 * }}
 */
// @ts-ignore typedef
export let ProtocolColumnConfig;
