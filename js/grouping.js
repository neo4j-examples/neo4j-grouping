/*
 * Copyright © 2014 - 2018 Leipzig University (Database Research Group)
 * Copyright © 2018 Neo4j Inc (Adaption by Michael Hunger)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**---------------------------------------------------------------------------------------------------------------------
 * Global Values
 *-------------------------------------------------------------------------------------------------------------------*/
/**
 * Prefixes of the aggregation functions
 */
let aggrPrefixes = ['min ', 'max ', 'sum ']; // ,'avg ','collect ', 'count_*'

/**
 * Map of all possible values for the nodeLabelKey to a color in RGB format.
 * @type {{}}
 */
let colorMap = {};

/**
 * Buffers the last graph response from the server to improve redrawing speed.
 */
let bufferedData;

/**
 * True, if the graph layout should be force based
 * @type {boolean}
 */
let useForceLayout = true;

/**
 * True, if the default label should be used
 * @type {boolean}
 */
let useDefaultLabel = true;

/**
 * Maximum value for the count attribute of vertices
 * @type {number}
 */
let maxNodeCount = 0;

/**
 * Maximum value for the count attribute of relationships
 * @type {number}
 */
let maxRelationshipCount = 0;


/**---------------------------------------------------------------------------------------------------------------------
 * Callbacks
 *-------------------------------------------------------------------------------------------------------------------*/
/**
 * Reload the database properties whenever the database selection is changed
 */
$(document).on("change", "#databaseName", fillFields);

$(document).on("click", "#connect", loadDatabaseProperties);

/**
 * When the 'Show whole graph' button is clicked, send a request to the server for the whole graph
 */
$(document).on("click",'#showWholeGraph', function(e) {
    e.preventDefault();
    let btn = $(this);
    btn.addClass("loading");
    const session = driver.session();
    session.run("MATCH (n)-[r]->(m) WITH * LIMIT 150 RETURN collect(distinct m)+collect(distinct n) as nodes, collect(distinct r) as rels")
        .then(data => {
            useDefaultLabel = true;
            useForceLayout = false;
            drawGraph(fromCypher(data), true);
            btn.removeClass("loading");
            session.close();
        });
});

$(document).on("click",'#showMetaGraph', function(e) {
    e.preventDefault();
    let btn = $(this);
    btn.addClass("loading");
    const session = driver.session();
    session.run("CALL apoc.meta.graph() yield nodes, relationships as rels return *")
        .then(data => {
            useDefaultLabel = true;
            useForceLayout = false;
            drawGraph(fromCypher(data), true);
            btn.removeClass("loading");
            session.close();
        });
});

/**
 * Whenever one of the view options is changed, redraw the graph
 */
$(document).on("change", '.redraw', function() {
    drawGraph(bufferedData, false);
});

function fromCypher(data) {
    return data.records.map(r => ({
        nodes: r.get('nodes').map(n => ({
            group: 'nodes',
            data: {properties: convertNumbers(n.properties), id: n.identity.toNumber(), label: n.labels[0]},
            labels: n.labels
        })),
        relationships: r.get('rels').map(r => ({
            group: 'edges',
            data: {
                properties: convertNumbers(r.properties),
                id: r.identity.toNumber(),
                label: r.type,
                source: r.start.toNumber(),
                target: r.end.toNumber()
            },
            type: r.type
        }))
    }))[0];
}

/**
 * When the 'Execute' button is clicked, construct a request and send it to the server
 */
$(document).on('click', ".execute-button", function () {
    let btn = $(this);
    btn.addClass("loading");
    let reqData = {
        dbName: getSelectedDatabase(),
        nodeKeys: getValues("#nodePropertyKeys"),
        relationshipKeys: getValues("#relationshipPropertyKeys"),
        nodeAggrFuncs: getValues("#nodeAggrFuncs"),
        relationshipAggrFuncs: getValues("#relationshipAggrFuncs"),
        nodeFilters: getValues("#nodeFilters"),
        relationshipFilters: getValues("#relationshipFilters"),
        filterAllRelationships: getValues("#relationshipFilters") === ["none"]
    };
/*
    reqData.nodeFilters=["User"];
    reqData.relationshipFilters=["KNOWS"];
    reqData.nodeKeys=["country"];
    reqData.relationshipKeys=[];
    reqData.nodeAggrFuncs=["count *","max age"];
    reqData.relationshipAggrFuncs=["count *"];
*/
    let query = "call apoc.nodes.group($labels,$properties,$grouping,$config) yield node, relationship return collect(distinct node) as nodes, collect(distinct relationship) as rels";

    let config = {};
    if ((reqData.relationshipFilters||[]).length > 0) config['includeRels'] = reqData.relationshipFilters;
    // orphans, exclude rels, self-relationships


    let nodeAggr = reqData.nodeAggrFuncs.length > 0 ? reqData.nodeAggrFuncs.map(a => a.split(" ")).reduce(multiMerge, {}) : {"*":"count"};
    let relationshipAggr = reqData.relationshipAggrFuncs.length > 0 ? reqData.relationshipAggrFuncs.map(a => a.split(" ")).reduce(multiMerge,{}) : {"*":"count"};

    let params = {
        labels: reqData.nodeFilters.length > 0 ? reqData.nodeFilters : ['*'],
        properties: reqData.nodeKeys.concat(reqData.relationshipKeys),
        grouping: [nodeAggr, relationshipAggr], config: config
    };

    const session = driver.session();
    session.run(query, params).then(data => {
        useDefaultLabel = false;
        useForceLayout = true;
        drawGraph(fromCypher(data), true);
        btn.removeClass('loading');
        session.close();
    });
});

function multiMerge(agg, pair) {
    let x = (agg[pair[1]] || []);
    x.push(pair[0]);
    agg[pair[1]] = x;
    return agg;
}

function convertNumbers(data) {
    for (key in Object.keys(data)) {
        let val = data[key];
        if (neo4j.v1.isInt(val)) data[key] = val.toInt();
    }
    return data;
}

/**
 * Runs when the DOM is ready
 */
$(document).ready(function () {
    window.connections={};
    window.driver = null;
    connections['localhost'] = {url:"bolt://localhost", user:"neo4j", password:"test"};
    connections['community'] = {url:"bolt://138.197.15.1:7687", user:"all", password:"readonly"};
    cy = buildCytoscape();
    $('select').select2();
});

/**---------------------------------------------------------------------------------------------------------------------
 * Graph Drawing
 *-------------------------------------------------------------------------------------------------------------------*/
function buildCytoscape() {
    return cytoscape({
        container: document.getElementById('canvas'),
        style: cytoscape.stylesheet()
            .selector('node')
            .css({
                // define label content and font
                'content': function (node) {

                    let labelString = getLabel(node, getNodeLabelKey(), useDefaultLabel);

                    let properties = node.data('properties');
                    let values = Object.keys(properties).map(k => properties[k]).filter(v => v != null).join(", ");
                    // todo order of aggregation +
                    labelString += '\n('+ values + ')';

                    if (labelString.length > 20) labelString = labelString.substring(0,20)+"...";
/*
                    if (properties['count_*'] != null) {
                        labelString += ' (' + properties['count_*'] + ')';
                    }
*/
                    return labelString;
                },
                // if the count shall effect the node size, set font size accordingly
                'font-size': function (node) {
                    if ($('#showCountAsSize').is(':checked')) {
                        let count = node.data('properties')['count_*'];
                        if (count != null) {
                            count = count / maxNodeCount;
                            // surface of vertices is proportional to count
                            return Math.max(2, Math.sqrt(count * 10000 / Math.PI));
                        }
                    }
                    return 10;
                },
                'text-valign': 'center',
                'color': 'black',
                // this function changes the text color according to the background color
                // unnecessary atm because only light colors can be generated
                /* function (vertices) {
                 let label = getLabel(vertices, nodeLabelKey, useDefaultLabel);
                 let bgColor = colorMap[label];
                 if (bgColor[0] + bgColor[1] + (bgColor[2] * 0.7) < 300) {
                 return 'white';
                 }
                 return 'black';
                 },*/
                // set background color according to color map
                'background-color': function (node) {
                    let label = getLabel(node, getNodeLabelKey(), useDefaultLabel);
                    let color = colorMap[label];
                    let result = '#';
                    result += ('0' + color[0].toString(16)).substr(-2);
                    result += ('0' + color[1].toString(16)).substr(-2);
                    result += ('0' + color[2].toString(16)).substr(-2);
                    return result;
                },

                /* size of vertices can be determined by property count
                 count specifies that the node stands for
                 1 or more other vertices */
                'width': function (node) {
                    if ($('#showCountAsSize').is(':checked')) {
                        let count = node.data.properties['count_*'];
                        if (count !== null) {
                            count = count / maxNodeCount;
                            // surface of node is proportional to count
                            return Math.sqrt(count * 1000000 / Math.PI) + 'px';
                        }
                    }
                    return '60px';

                },
                'height': function (node) {
                    if ($('#showCountAsSize').is(':checked')) {
                        let count = node.data.properties['count_*'];
                        if (count !== null) {
                            count = count / maxNodeCount;
                            // surface of node is proportional to count
                            return Math.sqrt(count * 1000000 / Math.PI) + 'px';
                        }
                    }
                    return '60px';
                },
                'text-wrap': 'wrap'
            })
            .selector('edge')
            .css({
                'curve-style': 'bezier',
                // layout of relationship and relationship label
                'content': function (relationship) {

                    if (!$('#showRelationshipLabels').is(':checked')) {
                        return '';
                    }

                    let labelString = getLabel(relationship, getRelationshipLabelKey(), useDefaultLabel);

                    let properties = relationship.data('properties');

                    if (properties['count_*'] !== null) {
                        labelString += ' (' + properties['count_*'] + ')';
                    }

                    return labelString;
                },
                // if the count shall effect the node size, set font size accordingly
                'font-size': function (relationship) {
                    if ($('#showCountAsSize').is(':checked')) {
                        let count = node.data('properties')['count_*'];
                        if (count !== null) {
                            count = count / maxNodeCount;
                            // surface of vertices is proportional to count
                            return Math.max(2, Math.sqrt(count * 10000 / Math.PI));
                        }
                    }
                    return 10;
                },
                'line-color': '#999',
                // width of relationships can be determined by property count
                // count specifies that the relationship represents 1 or more other relationships
                'width': function (relationship) {
                    if ($('#showCountAsSize').is(':checked')) {
                        let count = relationship.data('properties')['count_*'];
                        if (count !== null) {
                            count = count / maxRelationshipCount;
                            return Math.sqrt(count * 1000);
                        }
                    }
                    return 2;
                },
                'target-arrow-shape': 'triangle',
                'target-arrow-color': '#000'
            })
            // properties of relationships and vertices in special states, e.g. invisible or faded
            .selector('.faded')
            .css({
                'opacity': 0.25,
                'text-opacity': 0
            })
            .selector('.invisible')
            .css({
                'opacity': 0,
                'text-opacity': 0
            }),
        ready: function () {
            window.cy = this;
            cy.elements().unselectify();
            /* if a node is selected, fade all relationships and vertices
            that are not in direct neighborhood of the node */
            cy.on('tap', 'node', function (e) {
                let node = e.cyTarget;
                let neighborhood = node.neighborhood().add(node);

                cy.elements().addClass('faded');
                neighborhood.removeClass('faded');
            });
            // remove fading by clicking somewhere else
            cy.on('tap', function (e) {

                if (e.cyTarget === cy) {
                    cy.elements().removeClass('faded');
                }
            });
        }
    });
}

/**
 * function called when the server returns the data
 * @param data graph data
 * @param initial indicates whether the data is drawn initially
 */
function drawGraph(data, initial = true) {
    // lists of vertices and relationships
    let nodes = data.nodes;
    let relationships = data.relationships;

    if(initial) {
        // buffer the data to speed up redrawing
        bufferedData = data;

        // compute maximum count of all vertices, used for scaling the node sizes
        maxNodeCount = nodes.reduce((acc, node) => {
            return Math.max(acc, Number(node.data.properties['count_*']||0))
        }, 0);

        let labels = new Set(nodes.map((node) => {
            return (!useDefaultLabel && getNodeLabelKey() !== 'label') ?
                node['data']['properties'][getNodeLabelKey()] : node['data']['label']
        }));

        // generate random colors for the node labels
console.log(labels);        
generateRandomColors(labels);
console.log(colorMap);
        // compute maximum count of all relationships, used for scaling the relationship sizes
        maxRelationshipCount = relationships.reduce((acc, relationship) => {
            return Math.max(acc, Number(relationship.data.properties['count_*']||0))
        }, 0);
    }

    cy.elements().remove();
    cy.add(nodes);
    cy.add(relationships);

    if ($('#hideNullGroups').is(':checked')) {
        hideNullGroups();
    }

    if ($('#hideDisconnected').is(':checked')) {
        hideDisconnected();
    }

    addQtip();

    cy.layout(chooseLayout());
}


function chooseLayout() {
// options for the force layout
    let cose = {
        name: 'cose',

        // called on `layoutready`
        ready: function () {
        },

        // called on `layoutstop`
        stop: function () {
        },

        // whether to animate while running the layout
        animate: true,

        // number of iterations between consecutive screen positions update (0 ->
        // only updated on the end)
        refresh: 4,

        // whether to fit the network view after when done
        fit: true,

        // padding on fit
        padding: 30,

        // constrain layout bounds; { x1, y1, x2, y2 } or { x1, y1, w, h }
        boundingBox: undefined,

        // whether to randomize node positions on the beginning
        randomize: true,

        // whether to use the JS console to print debug messages
        debug: false,

        // node repulsion (non overlapping) multiplier
        nodeRepulsion: 8000000,

        // node repulsion (overlapping) multiplier
        nodeOverlap: 10,

        // ideal relationship (non nested) length
        idealRelationshipLength: 1,

        // divisor to compute relationship forces
        relationshipElasticity: 100,

        // nesting factor (multiplier) to compute ideal relationship length for nested relationships
        nestingFactor: 5,

        // gravity force (constant)
        gravity: 250,

        // maximum number of iterations to perform
        numIter: 100,

        // initial temperature (maximum node displacement)
        initialTemp: 200,

        // cooling factor (how the temperature is reduced between consecutive iterations
        coolingFactor: 0.95,

        // lower temperature threshold (below this point the layout will end)
        minTemp: 1.0
    };

    let radialRandom = {
        name: 'preset',
        positions: function() {

            let r = random() * 1000001;
            let theta = random() * 2 * (Math.PI);
            return {
                x: Math.sqrt(r) * Math.sin(theta),
                y: Math.sqrt(r) * Math.cos(theta)
            };
        },
        zoom: undefined,
        pan: undefined,
        fit: true,
        padding: 30,
        animate: false,
        animationDuration: 500,
        animationEasing: undefined,
        ready: undefined,
        stop: undefined
    };

    if (useForceLayout) {
        return cose;
    } else {
        return radialRandom;
    }
}

/**
 * Add a custom Qtip to the vertices and relationships of the graph.
 */
function addQtip() {
    cy.elements().qtip({
        content: function () {
            let qtipText = '';
            for (let [key, value] of Object.entries(this.data())) {
                if (key !== 'properties' && key !== 'pie_parameters') {
                    qtipText += key + ' : ' + value + '<br>';
                }
            }
            for (let [key, value] of Object.entries(this.data('properties'))) {
                qtipText += key + ' : ' + value + '<br>';
            }
            return qtipText;
        },
        position: {
            my: 'top center',
            at: 'bottom center'
        },
        style: {
            classes: 'MyQtip'
        }
    });
}

/**
 * Hide all vertices and relationships, that have a NULL property.
 */
function hideNullGroups() {
    let nodeKeys = getValues("#nodePropertyKeys");
    let relationshipKeys = getValues("#relationshipPropertyKeys");

    let nodes = [];
    for(let i = 0; i < cy.nodes().length; i++) {
        nodes[i] = cy.nodes()[i]
    }

    let relationships = [];
    for(let i = 0; i < cy.relationships().length; i++) {
        relationships[i] = cy.relationships()[i];
    }

    nodes
        .filter(node => nodeKeys.find((key) => node.data().properties[key] === "NULL"))
        .forEach(node => node.remove());

    relationships
        .filter(relationship => relationshipKeys.find((key) => relationship.data().properties[key] === "NULL"))
        .forEach(relationship => relationship.remove());
}

/**
 * Function to hide all disconnected vertices (vertices without relationships).
 */
function hideDisconnected() {
    let nodes = [];
    for(let i = 0; i < cy.nodes().length; i++) {
        nodes[i] = cy.nodes()[i]
    }

    nodes.filter(node => {
        return (cy.relationships('[source="' + node.id() + '"]').length === 0)
            && (cy.relationships('[target="' + node.id() + '"]').length === 0)
    }).forEach(node => node.remove());
}

/**---------------------------------------------------------------------------------------------------------------------
 * UI Initialization
 *-------------------------------------------------------------------------------------------------------------------*/

function fillFields() {
   let databaseName = getSelectedDatabase() || 'localhost';
   let con = connections[databaseName] || connections["localhost"];
   $('#url').val(con.url);
   $('#user').val(con.user);
   $('#password').val(con.password);
   $('#showMetaGraph').attr('disabled','disabled');
   $('#showWholeGraph').attr('disabled','disabled');
   $('#execute').attr('disabled','disabled');
}

/**
 * Initialize the database menu according to the selected database
 */
function loadDatabaseProperties() {
    if (driver !== null) driver.close();
    driver = neo4j.v1.driver($('#url').val(), neo4j.v1.auth.basic($('#user').val(), $('#password').val()));
    const session = driver.session();
    session.run(`
         CALL db.labels() yield label return label as name, 'label' as type 
         UNION ALL 
         CALL db.relationshipTypes() yield relationshipType return relationshipType as name, 'type' as type
         UNION ALL 
         CALL db.propertyKeys() yield propertyKey return propertyKey as name, 'prop' as type
        `).then(result => {
            let labels = result.records.filter(r => r.get('type') === 'label').map(record => record.get('name'));
            let types = result.records.filter(r => r.get('type') === 'type').map(record => record.get('name'));
            let keys = result.records.filter(r => r.get('type') === 'prop').map(record => ({name:record.get('name'), numerical:true})); // TODO
            session.close();
            let data = {nodeLabels:labels, relationshipLabels:types,nodeKeys:keys, relationshipKeys:keys};
            initializeFilterKeyMenus(data);
            initializePropertyKeyMenus(data);
            initializeAggregateFunctionMenus(data);
            $('#showMetaGraph').removeAttr('disabled');
            $('#showWholeGraph').removeAttr('disabled');
            $('#execute').removeAttr('disabled');
        });
   return false;
/*
    $.post('http://localhost:2342/keys/' + databaseName, function(response) {
        initializeFilterKeyMenus(response);
        initializePropertyKeyMenus(response);
        initializeAggregateFunctionMenus(response);
    }, "json");
*/
}

/**
 * Initialize the filter menus with the labels
 * @param keys labels of the input vertices
 */
function initializeFilterKeyMenus(keys) {
    let nodeFilters = $('#nodeFilters');
    let relationshipFilters = $('#relationshipFilters');

    // clear previous entries
    nodeFilters.html("");
    relationshipFilters.html("");


    // add one entry per node label
    keys.nodeLabels.forEach(label => {
        nodeFilters.append($("<option value='" + label + "'>" + label + "</option>"))
    });

    keys.relationshipLabels.forEach(label => {
        relationshipFilters.append($("<option value='" + label + "'>" + label + "</option>"))
    });
    relationshipFilters.append($("<option value='none'>None</option>"))

}

/**
 * Initialize the key propertyKeys menus.
 * @param keys array of node and relationship keys
 */
function initializePropertyKeyMenus(keys) {
    // get the propertyKeys menus in their current form
    let nodePropertyKeys = $('#nodePropertyKeys');
    let relationshipPropertyKeys = $('#relationshipPropertyKeys');

    // clear previous entries
    nodePropertyKeys.html("");
    relationshipPropertyKeys.html("");

    // add default key (label)
    nodePropertyKeys.append($("<option value='label'>label</option>"));
    relationshipPropertyKeys.append($("<option value='label'>label</option>"));

    // add one entry per property key
    keys.nodeKeys.forEach(key => {
        nodePropertyKeys.append($("<option value='" + key.name + "'>" + key.name + "</option>"))
    });

    keys.relationshipKeys.forEach(key => {
        relationshipPropertyKeys.append($("<option value='" + key.name + "'>" + key.name + "</option>"))
    });
}

/**
 * initialize the aggregate function propertyKeys menu
 */
function initializeAggregateFunctionMenus(keys) {
    let nodeAggrFuncs = $('#nodeAggrFuncs');
    let relationshipAggrFuncs = $('#relationshipAggrFuncs');

    // clear previous entries
    nodeAggrFuncs.html("");
    relationshipAggrFuncs.html("");

    // add default key (label)
    nodeAggrFuncs.append($("<option value='count *'>count</option>"));
    relationshipAggrFuncs.append($("<option value='count *'>count</option>"));

    // add one entry per property key
    keys.nodeKeys
        .filter(k => {return k.numerical})
        .forEach(key => {
             aggrPrefixes.forEach(prefix => {
                 let functionName = prefix + key.name;
                 nodeAggrFuncs.append($("<option value='" + functionName + "'>" + functionName + "</option>"))
             });
        });

    keys.relationshipKeys
        .filter(k => {return k.numerical})
        .forEach(key => {
            aggrPrefixes.forEach(prefix => {
                let functionName = prefix + key.name;
                relationshipAggrFuncs.append($("<option value='" + functionName + "'>" + functionName + "</option>"))
            });
        });
}

/**---------------------------------------------------------------------------------------------------------------------
 * Utility Functions
 *-------------------------------------------------------------------------------------------------------------------*/

var seed = 32453;
function random(s) {
	if (!s) s=seed;
	var x;
    do {
      x = Math.sin(s++) * 10000;
      x = x - Math.floor(x);
    } while(x < 0.15 || x > 0.9);
    seed = s;
    return (x-0.15) * 1 / 0.75; 
}
/**
 * Generate a random color for each label
 * @param labels array of labels
 */
// todo stable colors per label
function generateRandomColors(labels) {
    colorMap = {};
    random(32453);
    labels.forEach(function (label) {
        let r = 0;
        let g = 0;
        let b = 0;
        while (r + g + b < 382) {
            r = Math.floor((random() * 255));
            g = Math.floor((random() * 255));
            b = Math.floor((random() * 255));
        }
        colorMap[label] = [r, g, b];
    });
}

/**
 * Get the label of the given element, either the default label ('label') or the value of the
 * given property key
 * @param element the element whose label is needed
 * @param key key of the non-default label
 * @param useDefaultLabel boolean specifying if the default label shall be used
 * @returns {string} the label of the element
 */
function getLabel(element, key, useDefaultLabel) {
    let label = '';
    if (!useDefaultLabel && key !== 'label') {
        label += element.data('properties')[key];
    } else {
        label += element.data('label');
    }
    return label;
}

/**
 * get the selected database
 * @returns selected database name
 */
function getSelectedDatabase() {
    return $('#databaseName').val();
}

/**
 * Retrieve the values of the specified element as Array
 * @param element the html element
 * @returns {Array}
 */
function getValues(element) {
    return $(element).val() || []
}

function getNodePropertyKeys() {
    return getValues("#nodePropertyKeys");
}
/**
 * Property keys that are used to specify the node and relationship labels.
 */
function getNodeLabelKey() {
    let values = getNodePropertyKeys();
    return values.length === 0 ? "label" : values[0];
}

function getRelationshipPropertyKeys() {
    return getValues("#relationshipPropertyKeys");
}
function getRelationshipLabelKey() {
    let values = getRelationshipPropertyKeys();
    return values.length === 0 ? "label" : values[0];
}
