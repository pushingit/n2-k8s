import yargs from 'yargs'
import K8S from './lib/n2/k8s'
import config from 'config'

const errHandler = err => console.error(err.message || err.errors),
      k8s = (component, action) => {
	  let cluster = new K8S(config),
	      promise = cluster[action](component)
	  return (promise && promise.catch) ? promise.catch(errHandler)  : null
      }

let argv =  yargs
    .usage("$0 <action> <component> [--options]")
    .showHelpOnFail(true)
    .demandCommand()
    .command('teardown', "teardown nodes", (yargs) => {
	let cluster = new K8S(config)
	cluster.teardown().catch(errHandler)
    })
    .command('start', "start", (yargs) => {
	let cluster = new K8S(config)
	cluster.start().catch(errHandler)
    })
    .command('status', "status", (yargs) => {
	let cluster = new K8S(config)
	cluster
	    .storeStatus()
	    .then(status => console.log({status}))
	    .catch(errHandler)
    })
    .command('up', "up", (yargs) => {
	let cluster = new K8S(config)
	cluster.up().catch(errHandler)
    })
    .command('down', "down", (yargs) => {
	let cluster = new K8S(config)
	cluster.down().catch(errHandler)
    })
    .command('reset', "reset cluster", (yargs) => {
	let cluster = new K8S(config)
	cluster.reset().catch(errHandler)
    })
    .command('create', "create <component>", (yargs) => {
	return yargs
	    .demandCommand()
	    .command('network', 'network', yargs => {
		k8s('network', 'create')
	    })
	    .command('rules', 'rules', yargs => {
		k8s('rules', 'create')
	    })
	    .command('instances', 'instances', yargs => {
		k8s('instances', 'create')
	    })
	    .command('certificates', 'certificates', yargs => {
		k8s('certificates', 'create')
	    })
	    .command('rules', 'rules', yargs => {
		k8s('rules', 'create')
	    })
	    .command(['configs', 'configurations'], 'configs', yargs => {
		k8s('configurations', 'create')
	    })
	    .command('encryption', 'encryption', yargs => {
		k8s('encryption', 'create')
	    })
	    .command(['all', '$0'], 'all', yargs => {
		k8s('all', 'create')
	    })
    })
    .command('distribute', "distribute <component>", (yargs) => {
	return yargs
	    .command(['all', '$0'], 'all', yargs => {
		k8s('all', 'distribute')
	    })
    })
    .command('update', "update <component>", (yargs) => {
	return yargs
	    .command(['all', '$0'], 'all', yargs => {
		k8s('all', 'update')
	    })
	    .command('os', 'os', yargs => {
		k8s('os', 'update')
	    })
    })
    .argv;

