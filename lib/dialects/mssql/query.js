'use strict';

const Utils = require('../../utils');
const Promise = require('../../promise');
const AbstractQuery = require('../abstract/query');
const sequelizeErrors = require('../../errors.js');
const parserStore = require('../parserStore')('mssql');
const _ = require('lodash');

class Query extends AbstractQuery {
  constructor(connection, sequelize, options) {
    super();
    this.connection = connection;
    this.instance = options.instance;
    this.model = options.model;
    this.sequelize = sequelize;
    this.options = Utils._.extend({
      logging: console.log,
      plain: false,
      raw: false
    }, options || {});

    this.checkLoggingOption();
  }

  getInsertIdField() {
    return 'id';
  }

  _run(connection, sql, parameters) {
    this.sql = sql;

    //do we need benchmark for this query execution
    const benchmark = this.sequelize.options.benchmark || this.options.benchmark;
    let queryBegin;
    if (benchmark) {
      queryBegin = Date.now();
    } else {
      this.sequelize.log('Executing (' + (connection.uuid || 'default') + '): ' + this.sql, this.options);
    }

    return new Promise((resolve, reject) => {
        // TRANSACTION SUPPORT
        if (_.includes(this.sql, 'BEGIN TRANSACTION')) {
          connection.beginTransaction(err => {
            if (!!err) {
              reject(this.formatError(err));
            } else {
              resolve(this.formatResults());
            }
          } /* name, isolation_level */);
        } else if (_.includes(this.sql, 'COMMIT TRANSACTION')) {
          connection.commitTransaction(err => {
            if (!!err) {
              reject(this.formatError(err));
            } else {
              resolve(this.formatResults());
            }
          });
        } else if (_.includes(this.sql, 'ROLLBACK TRANSACTION')) {
          connection.rollbackTransaction(err => {
            if (!!err) {
              reject(this.formatError(err));
            } else {
              resolve(this.formatResults());
            }
          });
        } else {
          // QUERY SUPPORT
          const results = [];

          const request = new connection.lib.Request(this.sql, err => {

            if (benchmark) {
              this.sequelize.log('Executed (' + (connection.uuid || 'default') + '): ' + this.sql, (Date.now() - queryBegin), this.options);
            }

            if (err) {
              err.sql = sql;
              reject(this.formatError(err));
            } else {
              resolve(this.formatResults(results));
            }
          });

          request.on('row', columns => {
            const row = {};
            for (const column of columns) {
              const typeid = column.metadata.type.id;
              const parse = parserStore.get(typeid);
              let value = column.value;

              if (value !== null & !!parse) {
                value = parse(value);
              }
              row[column.metadata.colName] = value;
            }

            results.push(row);
          });

          connection.execSql(request);
        }
    });
  }

  run(sql, parameters) {
    return Promise.using(this.connection.lock(), connection => this._run(connection, sql, parameters));
  }

  /**
   * High level function that handles the results of a query execution.
   *
   *
   * Example:
   *  query.formatResults([
   *    {
   *      id: 1,              // this is from the main table
   *      attr2: 'snafu',     // this is from the main table
   *      Tasks.id: 1,        // this is from the associated table
   *      Tasks.title: 'task' // this is from the associated table
   *    }
   *  ])
   *
   * @param {Array} data - The result of the query execution.
   */
  formatResults(data) {
    let result = this.instance;
    if (this.isInsertQuery(data)) {
      this.handleInsertQuery(data);

      if (!this.instance) {
        if (this.options.plain) {
          // NOTE: super contrived. This just passes the newly added query-interface
          //       test returning only the PK. There isn't a way in MSSQL to identify
          //       that a given return value is the PK, and we have no schema information
          //       because there was no calling Model.
          const record = data[0];
          result = record[Object.keys(record)[0]];
        } else {
          result = data;
        }
      }
    }

    if (this.isShowTablesQuery()) {
      result = this.handleShowTablesQuery(data);
    } else if (this.isDescribeQuery()) {
      result = {};
      for (const _result of data) {
        if (_result.Default) {
          _result.Default = _result.Default.replace("('",'').replace("')",'').replace(/'/g,''); /* jshint ignore: line */
        }

        result[_result.Name] = {
          type: _result.Type.toUpperCase(),
          allowNull: (_result.IsNull === 'YES' ? true : false),
          defaultValue: _result.Default,
          primaryKey: _result.Constraint === 'PRIMARY KEY'
        };
      }
    } else if (this.isShowIndexesQuery()) {
      result = this.handleShowIndexesQuery(data);
    } else if (this.isSelectQuery()) {
      result = this.handleSelectQuery(data);
    } else if (this.isCallQuery()) {
      result = data[0];
    } else if (this.isBulkUpdateQuery()) {
      result = data.length;
    } else if (this.isBulkDeleteQuery()){
      result = data[0] && data[0].AFFECTEDROWS;
    } else if (this.isVersionQuery()) {
      result = data[0].version;
    } else if (this.isForeignKeysQuery()) {
      result = data;
    } else if (this.isRawQuery()) {
      // MSSQL returns row data and metadata (affected rows etc) in a single object - let's standarize it, sorta
      result = [data, data];
    }

    return result;
  }

  handleShowTablesQuery(results) {
    return results.map(resultSet => {
      return {
        tableName: resultSet.TABLE_NAME,
        schema: resultSet.TABLE_SCHEMA
      };
    });
  }

  formatError(err) {
    let match;
    match = err.message.match(/Violation of UNIQUE KEY constraint '((.|\s)*)'. Cannot insert duplicate key in object '.*'.(:? The duplicate key value is \((.*)\).)?/);
    match = match || err.message.match(/Cannot insert duplicate key row in object .* with unique index '(.*)'/);
    if (match && match.length > 1) {
      let fields = {};
      const uniqueKey = this.model && this.model.uniqueKeys[match[1]];
      let message = 'Validation error';

      if (uniqueKey && !!uniqueKey.msg) {
        message = uniqueKey.msg;
      }
      if (!!match[4]) {
        const values = match[4].split(',').map(part => part.trim());
        if (!!uniqueKey) {
          fields = Utils._.zipObject(uniqueKey.fields, values);
        } else {
          fields[match[1]] = match[4];
        }
      }

      const errors = [];
      Utils._.forOwn(fields, (value, field) => {
        errors.push(new sequelizeErrors.ValidationErrorItem(
          this.getUniqueConstraintErrorMessage(field),
          'unique violation', field, value
        ));
      });

      return new sequelizeErrors.UniqueConstraintError({message, errors, parent: err, fields});
    }

    match = err.message.match(/Failed on step '(.*)'.Could not create constraint. See previous errors./) ||
            err.message.match(/The DELETE statement conflicted with the REFERENCE constraint "(.*)". The conflict occurred in database "(.*)", table "(.*)", column '(.*)'./) ||
            err.message.match(/The INSERT statement conflicted with the FOREIGN KEY constraint "(.*)". The conflict occurred in database "(.*)", table "(.*)", column '(.*)'./) ||
            err.message.match(/The UPDATE statement conflicted with the FOREIGN KEY constraint "(.*)". The conflict occurred in database "(.*)", table "(.*)", column '(.*)'./);
    if (match && match.length > 0) {
      return new sequelizeErrors.ForeignKeyConstraintError({
        fields: null,
        index: match[1],
        parent: err
      });
    }

    return new sequelizeErrors.DatabaseError(err);
  }

  isShowOrDescribeQuery() {
    let result = false;

    result = result || (this.sql.toLowerCase().indexOf("select c.column_name as 'name', c.data_type as 'type', c.is_nullable as 'isnull'") === 0); /* jshint ignore: line */
    result = result || (this.sql.toLowerCase().indexOf('select tablename = t.name, name = ind.name,') === 0);
    result = result || (this.sql.toLowerCase().indexOf('exec sys.sp_helpindex @objname') === 0);

    return result;
  }

  isShowIndexesQuery() {
    return this.sql.toLowerCase().indexOf('exec sys.sp_helpindex @objname') === 0;
  }

  handleShowIndexesQuery(data) {
    // Group by index name, and collect all fields
    data = _.reduce(data, (acc, item) => {
      if (!(item.index_name in acc)) {
        acc[item.index_name] = item;
        item.fields = [];
      }

      Utils._.forEach(item.index_keys.split(','), column => {
        let columnName = column.trim();
        if (columnName.indexOf('(-)') !== -1) {
          columnName = columnName.replace('(-)','');
        }

        acc[item.index_name].fields.push({
          attribute: columnName,
          length: undefined,
          order: (column.indexOf('(-)') !== -1 ? 'DESC' : 'ASC'),
          collate: undefined
        });
      });
      delete item.index_keys;
      return acc;
    }, {});

    return Utils._.map(data, item => ({
      primary: (item.index_name.toLowerCase().indexOf('pk') === 0),
      fields: item.fields,
      name: item.index_name,
      tableName: undefined,
      unique: (item.index_description.toLowerCase().indexOf('unique') !== -1),
      type: undefined
    }));
  }

  handleInsertQuery(results, metaData) {
    if (this.instance) {
      // add the inserted row id to the instance
      const autoIncrementField = this.model.autoIncrementField;
      let id = null;
      let autoIncrementFieldAlias = null;

      if (this.model.rawAttributes.hasOwnProperty(autoIncrementField) &&
          this.model.rawAttributes[autoIncrementField].field !== undefined)
        autoIncrementFieldAlias = this.model.rawAttributes[autoIncrementField].field ;

      id = id || (results && results[0][this.getInsertIdField()]);
      id = id || (metaData && metaData[this.getInsertIdField()]);
      id = id || (results && results[0][autoIncrementField]);
      id = id || (autoIncrementFieldAlias && results && results[0][autoIncrementFieldAlias]);

      this.instance[autoIncrementField] = id;
    }
  }
}

module.exports = Query;
module.exports.Query = Query;
module.exports.default = Query;
